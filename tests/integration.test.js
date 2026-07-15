#!/usr/bin/env node
/*
 * Teste de integração ponta-a-ponta do VAP.
 *
 * Sobe o próprio server.js (processo filho) apontado para um Postgres de teste
 * e exercita as rotas HTTP reais: cadastro/login, habilitação, caronas,
 * pedidos, match, propostas, viagens, privacidade de telefone, isolamento por
 * projeto e o painel admin.
 *
 * Sem framework nem dependências novas — usa fetch nativo, assert e
 * child_process (Node >= 22, igual ao runtime do app).
 *
 * Uso:
 *   DATABASE_URL=postgres://... [JWT_SECRET=...] node tests/integration.test.js
 *
 * O banco precisa estar com o schema.sql aplicado (tabelas + projetos-semente
 * S11D/SALOBO/CARAJAS/SOSSEGO + admin 000000). O runner NÃO cria o schema.
 */

const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.TEST_PORT || 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || "test-secret-com-mais-de-32-caracteres-aqui-ok";

if (!process.env.DATABASE_URL) {
  console.error("ERRO: defina DATABASE_URL para um Postgres de teste (schema.sql aplicado).");
  process.exit(2);
}

// Fuso da sessão igual ao do server.js (pool.on("connect") -> SET TIME ZONE).
// As colunas de tempo são `timestamp` sem fuso; se o helper de teste gravar em
// UTC e o servidor ler em America/Sao_Paulo, os instantes escorregam ~3h e
// checagens como "GPS fresco" quebram. Mantém o teste fiel à produção.
const FUSO_APP = process.env.APP_TIMEZONE || "America/Sao_Paulo";
function pgTeste() {
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });
  pg.on("connect", (c) => c.query(`SET TIME ZONE '${FUSO_APP}'`).catch(() => {}));
  return pg;
}

/* ----------------------------- mini-harness ----------------------------- */
let passed = 0, failed = 0;
const falhas = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "asserção falhou");
}
const eq = (a, b, msg) => assert(a === b, `${msg || "eq"}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

async function test(nome, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${nome}`);
  } catch (err) {
    failed++;
    falhas.push({ nome, erro: err.message });
    console.log(`  \x1b[31m✗\x1b[0m ${nome}\n      \x1b[31m${err.message}\x1b[0m`);
  }
}
function grupo(nome) { console.log(`\n\x1b[1m${nome}\x1b[0m`); }

async function api(method, rota, { token, body, form } = {}) {
  const headers = {};
  let payload;
  if (form) {
    payload = form; // FormData
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${rota}`, { method, headers, body: payload });
  let json = null;
  const txt = await r.text();
  try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
  return { status: r.status, json };
}

/* --------------------------- boot do servidor --------------------------- */
function bootServer() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET,
      NODE_ENV: "test",           // SSL off; produção usaria rejectUnauthorized:false
      RAIO_MATCH_KM: "3",
      RAIO_VISIVEL_KM: "10",
      RAIO_ONLINE_KM: "0.6",
      RAIO_ROTA_KM: "2",
      RAIO_PROXIMO_KM: "4",
      FILA_OFERTA_TIMEOUT_S: "2", // curto de propósito, só pra testar o avanço por timeout
      FILA_TICK_MS: "500",
      AGENDADO_TICK_MS: "500",    // agendador rápido: ativa pedido agendado sem esperar 1 min
      AUTH_RATE_MAX: "60",        // teto conhecido p/ validar o anti-força-bruta no fim
                                  // (acima dos cadastros/logins legítimos; o loop de 40 ainda estoura)
      CORS_ORIGINS: "",           // sem CORS externo (comportamento padrão seguro)
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  child._log = () => log;
  return child;
}

async function esperarUp(timeoutMs = 20000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) return true;
    } catch { /* ainda subindo */ }
    await new Promise((s) => setTimeout(s, 300));
  }
  return false;
}

/* ------------------------------- fixtures ------------------------------- */
const uniq = Date.now().toString().slice(-6);
const mkMat = (n) => String(1000000 + Number(uniq) * 10 + n).slice(-6);

function novoUsuario(n, projeto_codigo) {
  const matricula = mkMat(n);
  return {
    nome: `Teste ${n}`,
    matricula,
    senha: "123456",
    telefone: `1199999${String(n).padStart(4, "0")}`,
    email: `teste${uniq}_${n}@example.com`,
    empresa_nome: "Empresa Teste",
    projeto_codigo,
    centro_custo: "CC1",
    sexo: n % 2 ? "M" : "F",
    aceite_politica: true,
    politica_versao: "1.0",
  };
}

// selfie/foto “já hospedadas” (o endpoint de habilitação/pedido aceita URL direta)
const SELFIE = "https://example.com/storage/v1/object/public/veiculos/selfies/s.jpg";
const CARRO = "https://example.com/storage/v1/object/public/veiculos/carros/c.jpg";
const nowISO = () => new Date().toISOString();

// Coordenadas próximas (mesma origem/destino) para casar no match (raio 3km)
const ORIGEM = { lat: -1.450000, lng: -48.480000 };
const DESTINO = { lat: -1.400000, lng: -48.440000 };

/* --------------------------------- run ---------------------------------- */
(async () => {
  const server = bootServer();
  const up = await esperarUp();
  if (!up) {
    console.error("Servidor não subiu a tempo. Log:\n" + server._log());
    server.kill("SIGKILL");
    process.exit(1);
  }
  console.log(`Servidor no ar em ${BASE}\n`);

  try {
    /* =================== PÚBLICO / HEALTHCHECK =================== */
    grupo("Público / healthcheck");
    await test("GET /api/config responde 200 com chaves esperadas", async () => {
      const { status, json } = await api("GET", "/api/config");
      eq(status, 200, "status");
      assert("mapsApiKey" in json && "pushPublicKey" in json, "faltam chaves de config");
      assert("mapsMapId" in json, "falta mapsMapId em /api/config");
    });
    await test("GET / serve o HTML de login", async () => {
      const r = await fetch(`${BASE}/`);
      eq(r.status, 200, "status");
    });
    await test("GET /api/projetos lista os 4 projetos-semente", async () => {
      const { status, json } = await api("GET", "/api/projetos");
      eq(status, 200, "status");
      assert(Array.isArray(json) && json.length >= 4, "esperava >= 4 projetos");
    });

    /* =================== CADASTRO / LOGIN =================== */
    grupo("Cadastro e login");
    const uDriver = novoUsuario(1, "S11D");
    const uPax = novoUsuario(2, "S11D");
    const uOutroProj = novoUsuario(3, "SALOBO");
    let tokDriver, tokPax, tokOutro, idDriver, idPax;

    await test("POST /api/register cria motorista (S11D) e devolve token", async () => {
      const { status, json } = await api("POST", "/api/register", { body: uDriver });
      eq(status, 200, "status");
      assert(json.token, "sem token");
      tokDriver = json.token; idDriver = json.user.id;
      eq(json.user.projeto_codigo, "S11D", "projeto");
    });
    await test("POST /api/register cria passageiro (S11D)", async () => {
      const { status, json } = await api("POST", "/api/register", { body: uPax });
      eq(status, 200, "status");
      tokPax = json.token; idPax = json.user.id;
    });
    await test("POST /api/register cria usuário de outro projeto (SALOBO)", async () => {
      const { status, json } = await api("POST", "/api/register", { body: uOutroProj });
      eq(status, 200, "status");
      tokOutro = json.token;
    });
    await test("register rejeita senha fora de 6 dígitos (400)", async () => {
      const bad = { ...novoUsuario(11, "S11D"), senha: "abc" };
      const { status } = await api("POST", "/api/register", { body: bad });
      eq(status, 400, "status");
    });
    await test("register rejeita email inválido (400)", async () => {
      const bad = { ...novoUsuario(12, "S11D"), email: "nao-eh-email" };
      const { status } = await api("POST", "/api/register", { body: bad });
      eq(status, 400, "status");
    });
    await test("register rejeita projeto inexistente (400)", async () => {
      const bad = { ...novoUsuario(13, "S11D"), projeto_codigo: "NAOEXISTE" };
      const { status } = await api("POST", "/api/register", { body: bad });
      eq(status, 400, "status");
    });
    await test("register rejeita matrícula duplicada (400)", async () => {
      const { status } = await api("POST", "/api/register", { body: uDriver });
      eq(status, 400, "status");
    });
    await test("register exige aceite da Política de Privacidade — LGPD (400)", async () => {
      const semAceite = { ...novoUsuario(14, "S11D") };
      delete semAceite.aceite_politica;
      const { status } = await api("POST", "/api/register", { body: semAceite });
      eq(status, 400, "status");
    });
    await test("POST /api/login com credenciais corretas", async () => {
      const { status, json } = await api("POST", "/api/login", {
        body: { matricula: uDriver.matricula, senha: uDriver.senha },
      });
      eq(status, 200, "status");
      assert(json.token, "sem token");
      // Sessão única por conta: este login rotaciona o sessao_id e mata o
      // token do register. Adota o novo, como o app real faria.
      tokDriver = json.token;
    });
    await test("login com senha errada → 401", async () => {
      const { status } = await api("POST", "/api/login", {
        body: { matricula: uDriver.matricula, senha: "000001" },
      });
      eq(status, 401, "status");
    });
    await test("login com matrícula inexistente → 401", async () => {
      const { status } = await api("POST", "/api/login", {
        body: { matricula: "999999", senha: "123456" },
      });
      eq(status, 401, "status");
    });

    /* =================== AUTH MIDDLEWARE =================== */
    grupo("Autenticação (middleware)");
    await test("rota protegida sem token → 401", async () => {
      const { status } = await api("GET", "/api/perfil");
      eq(status, 401, "status");
    });
    await test("rota protegida com token inválido → 401", async () => {
      const { status } = await api("GET", "/api/perfil", { token: "lixo.token.aqui" });
      eq(status, 401, "status");
    });

    /* =================== PERFIL =================== */
    grupo("Perfil");
    await test("GET /api/perfil devolve o próprio usuário", async () => {
      const { status, json } = await api("GET", "/api/perfil", { token: tokDriver });
      eq(status, 200, "status");
      eq(json.id, idDriver, "id");
    });
    await test("PATCH /api/perfil atualiza telefone", async () => {
      const { status, json } = await api("PATCH", "/api/perfil", {
        token: tokDriver, body: { telefone: "11888887777" },
      });
      eq(status, 200, "status");
      eq(json.telefone, "11888887777", "telefone");
    });
    await test("GET /api/perfil/favoritos → lista vazia", async () => {
      const { status, json } = await api("GET", "/api/perfil/favoritos", { token: tokDriver });
      eq(status, 200, "status");
      assert(Array.isArray(json), "array");
    });
    await test("PUT /api/perfil/favoritos salva e devolve", async () => {
      const body = {
        favoritos: [
          { nome: "Portaria S11D", busca: "Portaria S11D", grupo: "Acessos", ref: { lat: -6.4545, lng: -50.2081 } },
          { nome: "Usina A", busca: "Usina A S11D" },
        ],
      };
      const { status, json } = await api("PUT", "/api/perfil/favoritos", { token: tokDriver, body });
      eq(status, 200, "status");
      eq(json.length, 2, "qtd favoritos");
      const r2 = await api("GET", "/api/perfil/favoritos", { token: tokDriver });
      eq(r2.json.length, 2, "persistido");
    });

    /* =================== HABILITAÇÃO =================== */
    grupo("Habilitação do motorista");
    await test("POST /api/habilitacao ativa modo motorista", async () => {
      const { status, json } = await api("POST", "/api/habilitacao", {
        token: tokDriver,
        body: {
          placa: "ABC1D23", tag: "Gol prata",
          foto_carro_url: CARRO, foto_carro_em: nowISO(),
          selfie_url: SELFIE, selfie_em: nowISO(),
        },
      });
      eq(status, 200, "status");
      eq(json.status, "ativa", "status habilitação");
    });
    await test("habilitação sem placa → 400", async () => {
      const { status } = await api("POST", "/api/habilitacao", {
        token: tokDriver, body: { foto_carro_url: CARRO, selfie_url: SELFIE },
      });
      eq(status, 400, "status");
    });
    await test("GET /api/habilitacao/hoje devolve a habilitação ativa", async () => {
      const { status, json } = await api("GET", "/api/habilitacao/hoje", { token: tokDriver });
      eq(status, 200, "status");
      assert(json && json.status === "ativa", "sem habilitação ativa");
    });

    /* =================== MOTORISTA ONLINE =================== */
    grupo("Motorista online (sem destino)");
    await test("POST /api/motorista/online (habilitado) fica online", async () => {
      const { status, json } = await api("POST", "/api/motorista/online", {
        token: tokDriver,
        body: { lat: ORIGEM.lat, lng: ORIGEM.lng },
      });
      eq(status, 200, "status");
      assert(json.online, "deveria estar online");
    });
    await test("GET /api/motorista/online confirma status online", async () => {
      const { status, json } = await api("GET", "/api/motorista/online", { token: tokDriver });
      eq(status, 200, "status");
      assert(json.online, "online");
    });
    await test("passageiro vê motorista no modo amarelo (600 m)", async () => {
      const { status, json } = await api("GET", `/api/motoristas-online?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}`, { token: tokPax });
      eq(status, 200, "status");
      const m = json.find((x) => x.id === idDriver);
      assert(m, "motorista amarelo deve aparecer a 600 m");
      assert(!m.carona_id, "modo amarelo não traz carona_id");
    });
    await test("modo amarelo tolera GPS entre FRESH e STALE (5 min)", async () => {
      const pg = pgTeste();
      try {
        await pg.query(
          "UPDATE localizacoes_online SET atualizado_em = NOW() - INTERVAL '5 minutes' WHERE usuario_id = $1",
          [idDriver]
        );
      } finally {
        await pg.end();
      }
      const { status, json } = await api("GET", `/api/motoristas-online?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}`, { token: tokPax });
      eq(status, 200, "status");
      assert(json.find((x) => x.id === idDriver), "amarelo deve aparecer com GPS de 5 min");
      await api("POST", "/api/localizacao", {
        token: tokDriver,
        body: { lat: ORIGEM.lat, lng: ORIGEM.lng, disponivel: true },
      });
    });
    await test("passageiro sem hab NÃO fica online (403)", async () => {
      const { status } = await api("POST", "/api/motorista/online", {
        token: tokPax,
        body: { lat: ORIGEM.lat, lng: ORIGEM.lng },
      });
      eq(status, 403, "status");
    });

    /* =================== CARONAS =================== */
    grupo("Caronas");
    let caronaId;
    await test("POST /api/caronas exige habilitação (passageiro sem hab → 403)", async () => {
      const { status } = await api("POST", "/api/caronas", {
        token: tokPax,
        body: {
          origem_lat: ORIGEM.lat, origem_lng: ORIGEM.lng,
          destino_lat: DESTINO.lat, destino_lng: DESTINO.lng,
        },
      });
      eq(status, 403, "status");
    });
    await test("POST /api/caronas (motorista habilitado) cria carona", async () => {
      const { status, json } = await api("POST", "/api/caronas", {
        token: tokDriver,
        body: {
          origem_texto: "Portaria", origem_lat: ORIGEM.lat, origem_lng: ORIGEM.lng,
          destino_texto: "Alojamento", destino_lat: DESTINO.lat, destino_lng: DESTINO.lng,
          vagas: 3,
        },
      });
      eq(status, 200, "status");
      eq(json.status, "ativa", "status carona");
      caronaId = json.id;
    });
    await test("passageiro vê motorista com rota publicada (10 km)", async () => {
      const { status, json } = await api("GET", `/api/motoristas-online?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}`, { token: tokPax });
      eq(status, 200, "status");
      const m = json.find((x) => x.id === idDriver);
      assert(m, "motorista com rota publicada deve aparecer");
      assert(m.carona_id, "deve trazer carona_id");
    });
    await test("POST /api/caronas cancela carona anterior — lista sem duplicata", async () => {
      const { status: s1, json: j1 } = await api("POST", "/api/caronas", {
        token: tokDriver,
        body: {
          origem_texto: "Portaria", origem_lat: ORIGEM.lat, origem_lng: ORIGEM.lng,
          destino_texto: "Alojamento", destino_lat: DESTINO.lat, destino_lng: DESTINO.lng,
          vagas: 1,
        },
      });
      eq(s1, 200, "status republicar");
      const antiga = caronaId;
      caronaId = j1.id;
      assert(j1.id !== antiga, "nova carona deve ter id diferente");
      const q = `?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}&dest_lat=${DESTINO.lat}&dest_lng=${DESTINO.lng}`;
      const { status, json } = await api("GET", "/api/caronas" + q, { token: tokPax });
      eq(status, 200, "status lista");
      const doMotorista = json.filter((x) => x.motorista_id === j1.motorista_id);
      eq(doMotorista.length, 1, "só 1 carona ativa por motorista na lista");
      eq(doMotorista[0].id, j1.id, "deve ser a carona mais recente");
      eq(doMotorista[0].vagas, 1, "vagas da republicação");
    });
    await test("GPS expirado: motorista fantasma some de motoristas-online e caronas", async () => {
      const pg = pgTeste();
      try {
        await pg.query(
          "UPDATE localizacoes_online SET atualizado_em = NOW() - INTERVAL '10 minutes' WHERE usuario_id = $1",
          [idDriver]
        );
      } finally {
        await pg.end();
      }
      const q = `?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}`;
      const { status: s1, json: online } = await api("GET", `/api/motoristas-online${q}`, { token: tokPax });
      eq(s1, 200, "status motoristas-online");
      assert(!online.find((x) => x.id === idDriver), "GPS velho não deve aparecer no mapa");
      const q2 = `?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}&dest_lat=${DESTINO.lat}&dest_lng=${DESTINO.lng}`;
      const { status: s2, json: caronas } = await api("GET", "/api/caronas" + q2, { token: tokPax });
      eq(s2, 200, "status caronas");
      assert(!caronas.find((x) => x.id === caronaId), "carona sem GPS vivo não deve listar");
      // Restaura GPS para os testes seguintes
      await api("POST", "/api/localizacao", {
        token: tokDriver,
        body: { lat: ORIGEM.lat, lng: ORIGEM.lng, disponivel: true },
      });
    });
    await test("DELETE /api/motorista/online cancela carona ativa do motorista", async () => {
      const { status: s1 } = await api("DELETE", "/api/motorista/online", { token: tokDriver });
      eq(s1, 200, "status sair online");
      const pg = pgTeste();
      try {
        const { rows } = await pg.query("SELECT status FROM caronas WHERE id = $1", [caronaId]);
        eq(rows[0]?.status, "cancelada", "carona deve ser cancelada ao sair do online");
      } finally {
        await pg.end();
      }
      // Republica para testes seguintes
      const { status: s2, json: j2 } = await api("POST", "/api/caronas", {
        token: tokDriver,
        body: {
          origem_texto: "Portaria", origem_lat: ORIGEM.lat, origem_lng: ORIGEM.lng,
          destino_texto: "Alojamento", destino_lat: DESTINO.lat, destino_lng: DESTINO.lng,
          vagas: 1,
        },
      });
      eq(s2, 200, "status republicar após sair");
      caronaId = j2.id;
      await api("POST", "/api/localizacao", {
        token: tokDriver,
        body: { lat: ORIGEM.lat, lng: ORIGEM.lng, disponivel: true },
      });
    });
    await test("GET /api/caronas?meus lista a carona do motorista", async () => {
      const { status, json } = await api("GET", "/api/caronas?meus=1", { token: tokDriver });
      eq(status, 200, "status");
      assert(json.some((c) => c.id === caronaId), "carona não veio em ?meus");
    });
    await test("GET /api/caronas?dest lista motoristas indo para o local (empresa + km, só com vaga)", async () => {
      const q = `?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}&dest_lat=${DESTINO.lat}&dest_lng=${DESTINO.lng}`;
      const { status, json } = await api("GET", "/api/caronas" + q, { token: tokPax });
      eq(status, 200, "status");
      const c = json.find((x) => x.id === caronaId);
      assert(c, "a carona indo para o destino não apareceu");
      assert("motorista_empresa" in c, "faltou a empresa do motorista no retorno");
      assert(c.dist_origem != null, "faltou a distância (km) da minha posição");
    });
    await test("GET /api/caronas?dest não casa destino distante", async () => {
      const q = `?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}&dest_lat=-2.9&dest_lng=-49.9`;
      const { status, json } = await api("GET", "/api/caronas" + q, { token: tokPax });
      eq(status, 200, "status");
      assert(!json.some((x) => x.id === caronaId), "não deveria casar um destino distante");
    });
    await test("GET /api/caronas?dest casa destino no caminho (passageiro desce antes)", async () => {
      const parada = {
        lat: ORIGEM.lat + (DESTINO.lat - ORIGEM.lat) * 0.35,
        lng: ORIGEM.lng + (DESTINO.lng - ORIGEM.lng) * 0.35,
      };
      const q = `?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}&dest_lat=${parada.lat}&dest_lng=${parada.lng}`;
      const { status, json } = await api("GET", "/api/caronas" + q, { token: tokPax });
      eq(status, 200, "status");
      const c = json.find((x) => x.id === caronaId);
      assert(c, "carona deveria aparecer — parada no trajeto publicado");
      assert(c.compat_rota === "total", "parada no meio deve ser compat total");
    });
    await test("GET /api/caronas?dest não casa destino além do fim da rota (longe)", async () => {
      const alemLonge = {
        lat: DESTINO.lat + (DESTINO.lat - ORIGEM.lat) * 0.8,
        lng: DESTINO.lng + (DESTINO.lng - ORIGEM.lng) * 0.8,
      };
      const q = `?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}&dest_lat=${alemLonge.lat}&dest_lng=${alemLonge.lng}`;
      const { status, json } = await api("GET", "/api/caronas" + q, { token: tokPax });
      eq(status, 200, "status");
      assert(!json.some((x) => x.id === caronaId), "destino muito além do fim não deve casar");
    });
    await test("GET /api/caronas?dest marca parcial quando destino só um pouco além", async () => {
      // 25% do segmento (~7,1 km) ≈ 1,8 km além do fim: passa do raio de "mesmo
      // destino" (RAIO_MESMO_DEST_KM=1,5 → seria total) mas fica dentro do
      // corredor (RAIO_ROTA_KM=2 no env do teste) → parcial.
      const alemPerto = {
        lat: DESTINO.lat + (DESTINO.lat - ORIGEM.lat) * 0.25,
        lng: DESTINO.lng + (DESTINO.lng - ORIGEM.lng) * 0.25,
      };
      const q = `?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}&dest_lat=${alemPerto.lat}&dest_lng=${alemPerto.lng}`;
      const { status, json } = await api("GET", "/api/caronas" + q, { token: tokPax });
      eq(status, 200, "status");
      const c = json.find((x) => x.id === caronaId);
      if (c) assert(c.compat_rota === "parcial", "destino logo após o fim deve ser parcial, não total");
    });

    /* =================== PEDIDOS =================== */
    grupo("Pedidos");
    let pedidoId;
    await test("POST /api/pedidos exige selfie (sem selfie → 400)", async () => {
      const { status } = await api("POST", "/api/pedidos", {
        token: tokPax,
        body: {
          origem_lat: ORIGEM.lat, origem_lng: ORIGEM.lng,
          destino_lat: DESTINO.lat, destino_lng: DESTINO.lng,
        },
      });
      eq(status, 400, "status");
    });
    await test("POST /api/pedidos (com selfie) cria pedido", async () => {
      const { status, json } = await api("POST", "/api/pedidos", {
        token: tokPax,
        body: {
          origem_texto: "Portaria", origem_lat: ORIGEM.lat, origem_lng: ORIGEM.lng,
          destino_texto: "Alojamento", destino_lat: DESTINO.lat, destino_lng: DESTINO.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1,
        },
      });
      eq(status, 200, "status");
      eq(json.status, "aberto", "status pedido");
      pedidoId = json.id;
    });
    await test("GET /api/pedidos?meus lista o pedido do passageiro", async () => {
      const { status, json } = await api("GET", "/api/pedidos?meus=1", { token: tokPax });
      eq(status, 200, "status");
      assert(json.some((p) => p.id === pedidoId), "pedido não veio em ?meus");
    });

    /* =================== AGENDAMENTO =================== */
    grupo("Agendamento de pedido (horário futuro)");
    const uAgenda = novoUsuario(7, "S11D");
    let tokAgenda, pedidoAgendadoId;
    const datetimeLocalDaqui = (horas) => {
      const d = new Date(Date.now() + horas * 3600 * 1000);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    await test("registra passageiro para agendamento", async () => {
      const { status, json } = await api("POST", "/api/register", { body: uAgenda });
      eq(status, 200, "status");
      tokAgenda = json.token;
    });
    await test("POST /api/pedidos com horário futuro devolve agendado_futuro=true", async () => {
      const { status, json } = await api("POST", "/api/pedidos", {
        token: tokAgenda,
        body: {
          origem_texto: "Portaria", origem_lat: ORIGEM.lat, origem_lng: ORIGEM.lng,
          destino_texto: "Alojamento", destino_lat: DESTINO.lat, destino_lng: DESTINO.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1,
          horario: datetimeLocalDaqui(24),
          usar_fila: true,
        },
      });
      eq(status, 200, "status");
      eq(json.agendado_futuro, true, "agendado_futuro deveria ser true para horário futuro");
      assert(json.horario, "pedido agendado deveria guardar o horário");
      pedidoAgendadoId = json.id;
    });
    await test("PATCH /api/pedidos/:id altera horário do agendamento futuro", async () => {
      const novoHor = datetimeLocalDaqui(48);
      const { status, json } = await api("PATCH", "/api/pedidos/" + pedidoAgendadoId, {
        token: tokAgenda,
        body: { horario: novoHor, pessoas: 2 },
      });
      eq(status, 200, "status");
      eq(json.pessoas, 2, "pessoas");
      eq(json.agendado_futuro, true, "continua agendado");
    });
    await test("pedido agendado NÃO aparece no mapa do motorista antes da hora", async () => {
      const { status, json } = await api(
        "GET", `/api/pedidos?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}`, { token: tokDriver });
      eq(status, 200, "status");
      assert(json.every((p) => !p.horario || new Date(p.horario) <= new Date(Date.now() + 60000)),
        "pedido com horário futuro não deveria aparecer para o motorista");
    });
    await test("POST imediato NÃO cancela agendamento futuro do mesmo passageiro", async () => {
      const { status, json } = await api("POST", "/api/pedidos", {
        token: tokAgenda,
        body: {
          origem_texto: "Portaria", origem_lat: ORIGEM.lat, origem_lng: ORIGEM.lng,
          destino_texto: "Alojamento", destino_lat: DESTINO.lat, destino_lng: DESTINO.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1,
          usar_fila: true,
        },
      });
      eq(status, 200, "status");
      eq(json.agendado_futuro, false, "pedido sem horário é imediato");
      const { status: s2, json: meus } = await api("GET", "/api/pedidos?meus=1", { token: tokAgenda });
      eq(s2, 200, "status meus");
      assert(meus.some((p) => p.id === pedidoAgendadoId && p.status === "aberto"),
        "agendamento futuro deveria continuar aberto");
      assert(meus.some((p) => p.id === json.id && !p.horario),
        "pedido imediato também deveria estar aberto");
    });

    /* =================== MATCH (Haversine) =================== */
    grupo("Match por proximidade");
    await test("GET /api/caronas/match acha a carona compatível com o pedido", async () => {
      const { status, json } = await api("GET", `/api/caronas/match?pedido_id=${pedidoId}`, { token: tokPax });
      eq(status, 200, "status");
      assert(json.some((c) => c.id === caronaId), "match de carona não encontrou a carona próxima");
    });
    await test("GET /api/pedidos/match acha o pedido compatível com a carona", async () => {
      const { status, json } = await api("GET", `/api/pedidos/match?carona_id=${caronaId}`, { token: tokDriver });
      eq(status, 200, "status");
      assert(json.some((p) => p.id === pedidoId), "match de pedido não encontrou o pedido próximo");
    });

    /* =================== ISOLAMENTO POR PROJETO =================== */
    grupo("Isolamento por projeto");
    await test("usuário de outro projeto NÃO pode propor vaga na carona (403)", async () => {
      const { status } = await api("POST", "/api/propostas", {
        token: tokOutro,
        body: { carona_id: caronaId, selfie_url: SELFIE, selfie_em: nowISO() },
      });
      eq(status, 403, "status");
    });

    /* =================== PROPOSTAS + PRIVACIDADE =================== */
    grupo("Propostas, aceite e privacidade de telefone");
    let propostaId, viagemId;
    await test("passageiro propõe vaga na carona (selfie obrigatória) → cria proposta", async () => {
      const { status, json } = await api("POST", "/api/propostas", {
        token: tokPax,
        body: { carona_id: caronaId, selfie_url: SELFIE, selfie_em: nowISO(), mensagem: "posso ir?" },
      });
      eq(status, 200, "status");
      eq(json.status, "pendente", "status proposta");
      propostaId = json.id;
    });
    await test("proposta sem selfie na carona → 400", async () => {
      const { status } = await api("POST", "/api/propostas", {
        token: tokPax, body: { carona_id: caronaId },
      });
      eq(status, 400, "status");
    });
    await test("telefone fica OCULTO enquanto proposta pendente", async () => {
      const { status, json } = await api("GET", "/api/propostas", { token: tokDriver });
      eq(status, 200, "status");
      const p = json.find((x) => x.id === propostaId);
      assert(p, "proposta não listada para o motorista");
      eq(p.de_telefone, null, "de_telefone deveria ser null antes do aceite");
      eq(p.para_telefone, null, "para_telefone deveria ser null antes do aceite");
    });
    await test("motorista aceita a proposta → cria viagem", async () => {
      const { status, json } = await api("POST", `/api/propostas/${propostaId}/aceitar`, { token: tokDriver });
      eq(status, 200, "status");
      eq(json.status, "aceito", "status");
      assert(json.viagem_id, "não criou viagem no aceite");
      viagemId = json.viagem_id;
    });
    await test("telefone é REVELADO após o aceite", async () => {
      const { status, json } = await api("GET", "/api/propostas", { token: tokDriver });
      eq(status, 200, "status");
      const p = json.find((x) => x.id === propostaId);
      assert(p && p.de_telefone, "de_telefone deveria aparecer após aceite");
    });

    /* =================== VIAGEM (rota + finalização) =================== */
    grupo("Viagem: rota GPS e finalização");
    await test("motorista grava pontos GPS da viagem", async () => {
      await api("POST", `/api/viagens/${viagemId}/iniciar`, { token: tokDriver });
      const { status, json } = await api("POST", `/api/viagens/${viagemId}/pontos`, {
        token: tokDriver,
        // Trajeto plausível: o cálculo de km só conta pontos APÓS o embarque_em
        // (timestamps passados caem fora) e descarta segmentos acima de
        // KM_VELOCIDADE_MAX_H (120 km/h). Aqui: ~0,28 km a cada 14 s ≈ 73 km/h,
        // dentro da janela de +60 s aceita pelo servidor.
        body: { pontos: [
          { lat: -1.4500, lng: -48.4800, em: Date.now() + 2000 },
          { lat: -1.4480, lng: -48.4784, em: Date.now() + 16000 },
          { lat: -1.4460, lng: -48.4768, em: Date.now() + 30000 },
          { lat: -1.4440, lng: -48.4752, em: Date.now() + 44000 },
          { lat: -1.4420, lng: -48.4736, em: Date.now() + 58000 },
        ] },
      });
      eq(status, 200, "status");
      assert(json.gravados >= 3, "não gravou os pontos");
    });
    await test("estranho NÃO pode gravar pontos na viagem alheia (403)", async () => {
      const { status } = await api("POST", `/api/viagens/${viagemId}/pontos`, {
        token: tokOutro, body: { pontos: [{ lat: -1.44, lng: -48.47 }] },
      });
      eq(status, 403, "status");
    });
    await test("passageiro NÃO pode finalizar (só o motorista) → 403", async () => {
      const { status } = await api("POST", `/api/viagens/${viagemId}/finalizar`, { token: tokPax });
      eq(status, 403, "status");
    });
    await test("motorista finaliza a viagem e calcula distância", async () => {
      const { status, json } = await api("POST", `/api/viagens/${viagemId}/finalizar`, { token: tokDriver });
      eq(status, 200, "status");
      eq(json.status, "concluida", "status viagem");
      assert(Number(json.distancia_km) > 0, "distância deveria ser > 0");
    });
    await test("GET /api/viagens lista a viagem para o passageiro", async () => {
      const { status, json } = await api("GET", "/api/viagens", { token: tokPax });
      eq(status, 200, "status");
      assert(json.some((v) => v.id === viagemId), "viagem não listada");
    });

    /* =================== MOTORISTA ONLINE: VISIBILIDADE DE PEDIDOS ===================
       Fica por último: entrar no modo online (sem destino) CANCELA a carona ativa
       do motorista, então roda depois dos testes que dependem da carona-fixture. */
    grupo("Motorista online: pedidos por perto (600 m)");
    await test("motorista online vê pedido dentro de 600 m", async () => {
      await api("POST", "/api/motorista/online", {
        token: tokDriver,
        body: { lat: ORIGEM.lat, lng: ORIGEM.lng },
      });
      // O pedido original do passageiro foi CANCELADO quando a proposta foi
      // aceita (ele embarcou). Cria um novo, sem fila automática (sem
      // usar_fila), para pulsar direto no mapa do motorista.
      const novo = await api("POST", "/api/pedidos", {
        token: tokPax,
        body: {
          origem_texto: "Portaria", origem_lat: ORIGEM.lat, origem_lng: ORIGEM.lng,
          destino_texto: "Alojamento", destino_lat: DESTINO.lat, destino_lng: DESTINO.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1,
        },
      });
      eq(novo.status, 200, "status novo pedido");
      pedidoId = novo.json.id;
      const { status, json } = await api("GET", `/api/pedidos?lat=${ORIGEM.lat}&lng=${ORIGEM.lng}`, { token: tokDriver });
      eq(status, 200, "status");
      assert(json.some((p) => p.id === pedidoId), "pedido perto não listado");
    });
    await test("motorista online NÃO vê pedido fora de 600 m", async () => {
      const longe = { lat: ORIGEM.lat + 0.01, lng: ORIGEM.lng };
      const { status, json } = await api("GET", `/api/pedidos?lat=${longe.lat}&lng=${longe.lng}`, { token: tokDriver });
      eq(status, 200, "status");
      assert(!json.some((p) => p.id === pedidoId), "pedido longe não deveria aparecer");
    });

    /* =================== FILA DE MOTORISTAS NA ROTA (chamada sequencial) =================== */
    grupo("Fila de motoristas na rota (mais perto primeiro, trava no 1º aceite)");
    const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
    // Rota isolada (bem longe de ORIGEM/DESTINO usados no resto do arquivo): evita
    // pegar carona/motorista online de outro teste que por acaso caia no raio da rota.
    const ORIGEM_FILA = { lat: -1.550000, lng: -48.600000 };
    const DESTINO_FILA = { lat: -1.500000, lng: -48.550000 };
    const naRota = (frac) => ({
      lat: ORIGEM_FILA.lat + (DESTINO_FILA.lat - ORIGEM_FILA.lat) * frac,
      lng: ORIGEM_FILA.lng + (DESTINO_FILA.lng - ORIGEM_FILA.lng) * frac,
    });
    const uFilaA = novoUsuario(20, "S11D");
    const uFilaB = novoUsuario(21, "S11D");
    const uFilaC = novoUsuario(22, "S11D");
    const uFilaPax = novoUsuario(23, "S11D");
    let tokFilaA, tokFilaB, tokFilaC, tokFilaPax, pedidoFilaId, ofertaAId, ofertaBId;

    await test("prepara 3 motoristas na rota (perto -> longe) + 1 passageiro", async () => {
      for (const [u, setTok] of [
        [uFilaA, (t) => (tokFilaA = t)], [uFilaB, (t) => (tokFilaB = t)],
        [uFilaC, (t) => (tokFilaC = t)], [uFilaPax, (t) => (tokFilaPax = t)],
      ]) {
        const { status, json } = await api("POST", "/api/register", { body: u });
        eq(status, 200, "registro");
        setTok(json.token);
      }
      for (const tok of [tokFilaA, tokFilaB, tokFilaC]) {
        const { status } = await api("POST", "/api/habilitacao", {
          token: tok,
          body: { placa: "FIL" + Math.floor(Math.random() * 9000 + 1000), tag: "Fila",
            foto_carro_url: CARRO, foto_carro_em: nowISO(), selfie_url: SELFIE, selfie_em: nowISO() },
        });
        eq(status, 200, "habilitação");
      }
      const posA = naRota(0.1), posB = naRota(0.5), posC = naRota(0.9);
      for (const [tok, pos] of [[tokFilaA, posA], [tokFilaB, posB], [tokFilaC, posC]]) {
        const { status } = await api("POST", "/api/motorista/online", { token: tok, body: { lat: pos.lat, lng: pos.lng } });
        eq(status, 200, "ficar online");
      }
    });

    await test("POST /api/pedidos com usar_fila cria o pedido e inicia a fila", async () => {
      const { status, json } = await api("POST", "/api/pedidos", {
        token: tokFilaPax,
        body: {
          origem_texto: "Portaria", origem_lat: ORIGEM_FILA.lat, origem_lng: ORIGEM_FILA.lng,
          destino_texto: "Usina", destino_lat: DESTINO_FILA.lat, destino_lng: DESTINO_FILA.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1, usar_fila: true,
        },
      });
      eq(status, 200, "status");
      pedidoFilaId = json.id;
    });

    await test("GET /api/motoristas-rota lista os 3 motoristas ordenados do mais perto pro mais longe", async () => {
      const q = `?origem_lat=${ORIGEM_FILA.lat}&origem_lng=${ORIGEM_FILA.lng}&destino_lat=${DESTINO_FILA.lat}&destino_lng=${DESTINO_FILA.lng}`;
      const { status, json } = await api("GET", "/api/motoristas-rota" + q, { token: tokFilaPax });
      eq(status, 200, "status");
      const ids = json.map((m) => m.id);
      assert(ids.length >= 3, `esperava >= 3 motoristas na rota, veio ${ids.length}`);
      // Ordenado por distância crescente (ordem 0 = mais perto)
      const ordens = json.map((m) => m.ordem);
      eq(JSON.stringify(ordens.slice(0, ordens.length)), JSON.stringify([...ordens].sort((a, b) => a - b)), "ordem crescente");
    });

    await test("motorista mais perto (A) recebe a oferta; o do meio (B) ainda não", async () => {
      await dormir(300);
      const rA = await api("GET", "/api/motorista/oferta-atual", { token: tokFilaA });
      eq(rA.status, 200, "status A");
      assert(rA.json && rA.json.pedido_id === pedidoFilaId, "A deveria ter a oferta ativa");
      ofertaAId = rA.json.id;

      const rB = await api("GET", "/api/motorista/oferta-atual", { token: tokFilaB });
      eq(rB.status, 200, "status B");
      eq(rB.json, null, "B não deveria ter oferta ainda");
    });

    await test("motorista da vez (pedido_id) via /api/propostas é bloqueado — fila ativa", async () => {
      const { status, json } = await api("POST", "/api/propostas", { token: tokFilaB, body: { pedido_id: pedidoFilaId } });
      eq(status, 400, "status");
      assert(/busca automática/.test(json.error || ""), "mensagem deveria citar a busca automática");
    });

    await test("A recusa -> B (próximo mais perto) recebe a oferta na hora", async () => {
      const { status } = await api("POST", `/api/pedido-fila/${ofertaAId}/recusar`, { token: tokFilaA });
      eq(status, 200, "status recusar");
      await dormir(300);
      const rB = await api("GET", "/api/motorista/oferta-atual", { token: tokFilaB });
      assert(rB.json && rB.json.pedido_id === pedidoFilaId, "B deveria ter a oferta agora");
      ofertaBId = rB.json.id;
    });

    let viagemFilaId, propostaFilaId;
    await test("B aceita -> cria a viagem e trava a fila (C não recebe oferta)", async () => {
      const { status, json } = await api("POST", `/api/pedido-fila/${ofertaBId}/aceitar`, { token: tokFilaB });
      eq(status, 200, "status aceitar");
      assert(json.viagem_id, "deveria retornar viagem_id");
      viagemFilaId = json.viagem_id;
      propostaFilaId = json.proposta_id;

      const rC = await api("GET", "/api/motorista/oferta-atual", { token: tokFilaC });
      eq(rC.json, null, "C não deveria ter oferta — fila travada pelo aceite de B");
    });

    await test("cancelar a proposta aceita libera o passageiro: C é ofertado em seguida", async () => {
      const { status } = await api("POST", `/api/propostas/${propostaFilaId}/cancelar`, { token: tokFilaPax });
      eq(status, 200, "status cancelar");
      await dormir(300);
      const rC = await api("GET", "/api/motorista/oferta-atual", { token: tokFilaC });
      assert(rC.json && rC.json.pedido_id === pedidoFilaId, "C deveria ter a oferta depois do cancelamento");
    });

    await test("C não responde -> oferta expira sozinha e não sobra candidato (fila esgotada)", async () => {
      await dormir(3000); // FILA_OFERTA_TIMEOUT_S=2 + FILA_TICK_MS=0.5 no boot deste teste
      const rC = await api("GET", "/api/motorista/oferta-atual", { token: tokFilaC });
      eq(rC.json, null, "oferta de C deveria ter expirado");
    });

    /* =================== BUSCA HONESTA (fila-status + recusa avisada) =================== */
    grupo("Busca honesta: fila-status conta recusas/online e recusa some do mapa");
    await test("fila-status expõe esgotada, recusas e motoristas online", async () => {
      const { status, json } = await api("GET", `/api/pedidos/${pedidoFilaId}/fila-status`, { token: tokFilaPax });
      eq(status, 200, "status");
      eq(json.esgotada, true, "fila esgotada deveria vir sinalizada");
      eq(json.restantes, 0, "sem candidatos restantes");
      assert(json.recusas >= 1, `A recusou — recusas deveria ser >= 1, veio ${json.recusas}`);
      assert(typeof json.online === "number" && json.online >= 1,
        `deveria contar motoristas online no projeto, veio ${json.online}`);
    });

    let pedidoPulsoId;
    await test("pedido broadcast (sem fila): motorista perto vê o pulso", async () => {
      // A e B vão para a origem exata (dentro dos 600 m do modo amarelo).
      for (const tok of [tokFilaA, tokFilaB]) {
        const { status } = await api("POST", "/api/motorista/online", {
          token: tok, body: { lat: ORIGEM_FILA.lat, lng: ORIGEM_FILA.lng },
        });
        eq(status, 200, "ficar online na origem");
      }
      const novo = await api("POST", "/api/pedidos", {
        token: tokFilaPax,
        body: {
          origem_texto: "Portaria", origem_lat: ORIGEM_FILA.lat, origem_lng: ORIGEM_FILA.lng,
          destino_texto: "Usina", destino_lat: DESTINO_FILA.lat, destino_lng: DESTINO_FILA.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1,
        },
      });
      eq(novo.status, 200, "status novo pedido");
      pedidoPulsoId = novo.json.id;
      const { status, json } = await api(
        "GET", `/api/pedidos?lat=${ORIGEM_FILA.lat}&lng=${ORIGEM_FILA.lng}`, { token: tokFilaA });
      eq(status, 200, "status");
      assert(json.some((p) => p.id === pedidoPulsoId), "A deveria ver o pulso do pedido");
    });

    await test("A recusa o pulso -> pulso some SÓ para A e o robô chama o próximo (B)", async () => {
      const { status, json } = await api(
        "POST", `/api/pedidos/${pedidoPulsoId}/recusar-motorista`, { token: tokFilaA });
      eq(status, 200, "status recusar");
      // Pedido broadcast agora tem fila de NOTIFICAÇÃO (não-exclusiva): A era o
      // da vez, então a recusa avança o robô pro próximo na hora.
      eq(json.avancou, true, "recusa do motorista da vez deveria avançar a fila de notificação");

      const rA = await api("GET", `/api/pedidos?lat=${ORIGEM_FILA.lat}&lng=${ORIGEM_FILA.lng}`, { token: tokFilaA });
      assert(!rA.json.some((p) => p.id === pedidoPulsoId), "pulso não deveria voltar para quem recusou");

      const rB = await api("GET", `/api/pedidos?lat=${ORIGEM_FILA.lat}&lng=${ORIGEM_FILA.lng}`, { token: tokFilaB });
      assert(rB.json.some((p) => p.id === pedidoPulsoId), "B (não recusou) deveria continuar vendo o pulso");

      await dormir(300);
      const ofB = await api("GET", "/api/motorista/oferta-atual", { token: tokFilaB });
      assert(ofB.json && ofB.json.pedido_id === pedidoPulsoId, "B deveria ser o próximo chamado pelo robô");
    });

    await test("passageiro enxerga a recusa no fila-status do pedido broadcast", async () => {
      const { status, json } = await api("GET", `/api/pedidos/${pedidoPulsoId}/fila-status`, { token: tokFilaPax });
      eq(status, 200, "status");
      assert(json.recusas >= 1, `recusa do pulso deveria contar, veio ${json.recusas}`);
      assert(typeof json.online === "number" && json.online >= 1, "online deveria contar B disponível");
    });

    /* =================== PONTO EM COMUM (ENCAIXE) + MELHOR MOTORISTA ===================
       Cenário real S11D: o motorista vai da Portaria para a Usina; o passageiro
       está na Portaria e quer ir para a MINA (destino totalmente diferente, o
       corredor em linha reta não bate). Mas a rota do motorista passa por pontos
       conhecidos do catálogo (locais-favoritos.json) que ADIANTAM o passageiro —
       ele desce num ponto em comum e segue de lá. */
    grupo("Ponto em comum (encaixe): destino diferente, mesmo caminho");
    const PORTARIA_ENC = { lat: -6.454156, lng: -50.208344 };   // Portaria S11D
    const USINA_ENC = { lat: -6.448992, lng: -50.243534 };      // Rodoviária Arara Azul — Usina
    const MINA_ENC = { lat: -6.415464, lng: -50.320819 };       // Estação Bombeiros 09 — Mina
    const uEncD = novoUsuario(30, "S11D");   // motorista com rota Portaria -> Usina
    const uEncE = novoUsuario(31, "S11D");   // motorista amarelo, igualmente perto
    const uEncPax = novoUsuario(32, "S11D"); // passageiro Portaria -> Mina
    let tokEncD, tokEncE, tokEncPax, caronaEncId, pedidoEncId, ofertaEncId;

    await test("prepara motoristas D (carona p/ Usina) e E (amarelo) na Portaria", async () => {
      for (const [u, setTok] of [
        [uEncD, (t) => (tokEncD = t)], [uEncE, (t) => (tokEncE = t)], [uEncPax, (t) => (tokEncPax = t)],
      ]) {
        const { status, json } = await api("POST", "/api/register", { body: u });
        eq(status, 200, "registro");
        setTok(json.token);
      }
      for (const tok of [tokEncD, tokEncE]) {
        const { status } = await api("POST", "/api/habilitacao", {
          token: tok,
          body: { placa: "ENC" + Math.floor(Math.random() * 9000 + 1000), tag: "Encaixe",
            foto_carro_url: CARRO, foto_carro_em: nowISO(), selfie_url: SELFIE, selfie_em: nowISO() },
        });
        eq(status, 200, "habilitação");
      }
      // D publica a rota Portaria -> Usina e fica disponível na Portaria.
      const rCar = await api("POST", "/api/caronas", {
        token: tokEncD,
        body: {
          origem_texto: "Portaria S11D", origem_lat: PORTARIA_ENC.lat, origem_lng: PORTARIA_ENC.lng,
          destino_texto: "Usina", destino_lat: USINA_ENC.lat, destino_lng: USINA_ENC.lng,
          vagas: 2,
        },
      });
      eq(rCar.status, 200, "carona de D");
      caronaEncId = rCar.json.id;
      const rLoc = await api("POST", "/api/localizacao", {
        token: tokEncD, body: { lat: PORTARIA_ENC.lat, lng: PORTARIA_ENC.lng, disponivel: true },
      });
      eq(rLoc.status, 200, "localização de D");
      // E fica online (amarelo) também na Portaria — tão perto quanto D.
      const rOn = await api("POST", "/api/motorista/online", {
        token: tokEncE, body: { lat: PORTARIA_ENC.lat, lng: PORTARIA_ENC.lng },
      });
      eq(rOn.status, 200, "E online");
    });

    await test("carona para a Usina aparece como ENCAIXE para quem vai à Mina", async () => {
      const q = `?lat=${PORTARIA_ENC.lat}&lng=${PORTARIA_ENC.lng}&dest_lat=${MINA_ENC.lat}&dest_lng=${MINA_ENC.lng}`;
      const { status, json } = await api("GET", "/api/caronas" + q, { token: tokEncPax });
      eq(status, 200, "status");
      const c = json.find((x) => x.id === caronaEncId);
      assert(c, "carona da Usina deveria aparecer para quem vai à Mina (ponto em comum)");
      eq(c.compat_rota, "encaixe", "compat_rota");
      assert(c.encaixe_texto, "deveria dizer QUAL é o ponto em comum (nome do local)");
      assert(c.encaixe_lat != null && c.encaixe_lng != null, "ponto em comum precisa de coordenadas");
    });

    await test("pedido broadcast: quem tem ponto em comum é chamado ANTES do amarelo igualmente perto", async () => {
      const { status, json } = await api("POST", "/api/pedidos", {
        token: tokEncPax,
        body: {
          origem_texto: "Portaria S11D", origem_lat: PORTARIA_ENC.lat, origem_lng: PORTARIA_ENC.lng,
          destino_texto: "Mina", destino_lat: MINA_ENC.lat, destino_lng: MINA_ENC.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1,
        },
      });
      eq(status, 200, "status pedido");
      pedidoEncId = json.id;
      await dormir(300);
      const rD = await api("GET", "/api/motorista/oferta-atual", { token: tokEncD });
      assert(rD.json && rD.json.pedido_id === pedidoEncId,
        "D (rota com ponto em comum) deveria ser o primeiro chamado");
      assert(rD.json.encaixe_texto, "a oferta de D deveria trazer o ponto em comum");
      ofertaEncId = rD.json.id;
      const rE = await api("GET", "/api/motorista/oferta-atual", { token: tokEncE });
      eq(rE.json, null, "E (amarelo) não deveria ser chamado enquanto D não responde");
      // Pulso continua visível para E (fila não-exclusiva não esconde o pedido).
      const rMapaE = await api(
        "GET", `/api/pedidos?lat=${PORTARIA_ENC.lat}&lng=${PORTARIA_ENC.lng}`, { token: tokEncE });
      assert(rMapaE.json.some((p) => p.id === pedidoEncId), "pulso deveria continuar no mapa de E");
    });

    let viagemEncId;
    await test("D aceita e a viagem nasce PARCIAL até o ponto em comum", async () => {
      const { status, json } = await api("POST", `/api/pedido-fila/${ofertaEncId}/aceitar`, { token: tokEncD });
      eq(status, 200, "status aceitar");
      assert(json.viagem_id, "deveria criar a viagem");
      eq(json.parcial, true, "viagem deveria ser parcial (desembarque no ponto em comum)");
      viagemEncId = json.viagem_id;
    });

    /* =================== ROTA ÚNICA COM PARADA + ENCADEAMENTO =================== */
    grupo("Rota única com parada + carona encadeada (vagas)");
    await test("viagem devolve o destino FINAL do motorista (rota única com parada)", async () => {
      const { status, json } = await api("GET", `/api/viagens/${viagemEncId}`, { token: tokEncD });
      eq(status, 200, "status");
      assert(json.motorista_destino_final_lat != null && json.motorista_destino_final_lng != null,
        "viagem deveria trazer as coordenadas do destino final do motorista");
      eq(json.motorista_destino_final_texto, "Usina", "texto do destino final do motorista");
      // O desembarque do passageiro (ponto em comum) é uma PARADA antes do fim.
      assert(json.destino_motorista_lat != null, "parada (ponto em comum) deveria estar na viagem");
    });

    const uEncF = novoUsuario(33, "S11D");   // passageiro 2: quer encadear
    let tokEncF, pedidoEnc2Id;
    await test("motorista EM VIAGEM com vaga sobrando é chamado para a próxima perna", async () => {
      const r0 = await api("POST", "/api/register", { body: uEncF });
      eq(r0.status, 200, "registro F");
      tokEncF = r0.json.token;
      // F pede exatamente a rota publicada de D (compat total). D está em viagem
      // (levando o passageiro do encaixe), mas a carona tem 2 vagas e só 1 ocupada.
      const { status, json } = await api("POST", "/api/pedidos", {
        token: tokEncF,
        body: {
          origem_texto: "Portaria S11D", origem_lat: PORTARIA_ENC.lat, origem_lng: PORTARIA_ENC.lng,
          destino_texto: "Usina", destino_lat: USINA_ENC.lat, destino_lng: USINA_ENC.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1,
        },
      });
      eq(status, 200, "status pedido F");
      pedidoEnc2Id = json.id;
      await dormir(300);
      const rD = await api("GET", "/api/motorista/oferta-atual", { token: tokEncD });
      assert(rD.json && rD.json.pedido_id === pedidoEnc2Id,
        "D (rota total, em viagem, com vaga) deveria ser chamado antes do amarelo livre");
      const rE = await api("GET", "/api/motorista/oferta-atual", { token: tokEncE });
      eq(rE.json, null, "E não deveria ser chamado enquanto D não responde");
    });

    await test("passageiro 2 vê no fila-status que o motorista está finalizando outra corrida", async () => {
      const { status, json } = await api("GET", `/api/pedidos/${pedidoEnc2Id}/fila-status`, { token: tokEncF });
      eq(status, 200, "status");
      assert(json.atual, "deveria haver motorista sendo chamado");
      eq(json.atual.em_viagem, true, "atual.em_viagem deveria sinalizar a corrida em andamento");
    });

    /* =================== GPS FANTASMA: ROBÔ SÓ CHAMA GPS VIVO =================== */
    grupo("GPS fantasma: motorista com GPS parado não é chamado pelo robô");
    await test("com todos os GPS velhos, ninguém é ofertado e a fila fica vazia", async () => {
      // Envelhece o GPS de D e E além do limite de visibilidade (20 min > STALE
      // 15 min do modo amarelo e > FRESH 3 min da rota publicada) direto no banco
      // — simula app fechado/sem sinal, cenário real de produção.
      const pg = pgTeste();
      try {
        await pg.query(
          `UPDATE localizacoes_online SET atualizado_em = NOW() - INTERVAL '20 minutes'
           WHERE usuario_id IN (SELECT id FROM usuarios WHERE matricula IN ($1, $2))`,
          [uEncD.matricula, uEncE.matricula]
        );
      } finally { await pg.end(); }
      const { status, json } = await api("POST", "/api/pedidos", {
        token: tokEncF,
        body: {
          origem_texto: "Portaria S11D", origem_lat: PORTARIA_ENC.lat, origem_lng: PORTARIA_ENC.lng,
          destino_texto: "Usina", destino_lat: USINA_ENC.lat, destino_lng: USINA_ENC.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1,
        },
      });
      eq(status, 200, "status pedido");
      await dormir(300);
      const rD = await api("GET", "/api/motorista/oferta-atual", { token: tokEncD });
      const rE = await api("GET", "/api/motorista/oferta-atual", { token: tokEncE });
      const ofD = rD.json && rD.json.pedido_id === json.id;
      const ofE = rE.json && rE.json.pedido_id === json.id;
      assert(!ofD && !ofE, "motorista com GPS parado não deveria ser chamado pelo robô");
      const fs = await api("GET", `/api/pedidos/${json.id}/fila-status`, { token: tokEncF });
      eq(fs.status, 200, "status fila-status");
      eq(fs.json.atual, null, "não deveria haver motorista sendo chamado");
    });

    /* ============= DOUBLE-BOOKING: 1 pedido, 2 aceites simultâneos ============= */
    // Aceite pela FILA (robô) e aceite de uma PROPOSTA MANUAL disputando o MESMO
    // pedido no mesmo instante criavam DUAS viagens. O gate atômico
    // ('aberto'→'atendido' antes de inserir a viagem) tem que deixar UM vencer e
    // devolver erro claro (409/404) ao outro — nunca duas viagens pro mesmo pedido.
    grupo("Double-booking: dois aceites simultâneos no mesmo pedido");
    const DB_ORIG = { lat: -6.500000, lng: -50.050000 };
    const DB_DEST = { lat: -6.520000, lng: -50.090000 };
    const uDbG = novoUsuario(40, "S11D");   // motorista chamado pela fila
    const uDbH = novoUsuario(41, "S11D");   // motorista que oferta manualmente
    const uDbP = novoUsuario(42, "S11D");   // passageiro
    let tokDbG, tokDbH, tokDbP;
    await test("fila + proposta manual no mesmo pedido: um vencedor e UMA viagem só", async () => {
      for (const [u, set] of [[uDbG, (t) => (tokDbG = t)], [uDbH, (t) => (tokDbH = t)], [uDbP, (t) => (tokDbP = t)]]) {
        const r = await api("POST", "/api/register", { body: u });
        eq(r.status, 200, "registro");
        set(r.json.token);
      }
      // G e H habilitados e online na mesma origem — os dois candidatos do robô.
      for (const tok of [tokDbG, tokDbH]) {
        const h = await api("POST", "/api/habilitacao", {
          token: tok,
          body: { placa: "DBK" + Math.floor(Math.random() * 9000 + 1000), tag: "DoubleBook",
            foto_carro_url: CARRO, foto_carro_em: nowISO(), selfie_url: SELFIE, selfie_em: nowISO() },
        });
        eq(h.status, 200, "habilitação");
        const on = await api("POST", "/api/motorista/online", { token: tok, body: { lat: DB_ORIG.lat, lng: DB_ORIG.lng } });
        eq(on.status, 200, "online");
      }
      // P abre o pedido broadcast: o robô chama o melhor colocado pela fila.
      const ped = await api("POST", "/api/pedidos", {
        token: tokDbP,
        body: {
          origem_texto: "Origem DB", origem_lat: DB_ORIG.lat, origem_lng: DB_ORIG.lng,
          destino_texto: "Destino DB", destino_lat: DB_DEST.lat, destino_lng: DB_DEST.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1,
        },
      });
      eq(ped.status, 200, "status pedido");
      const pedidoId = ped.json.id;
      await dormir(300);
      // Quem a fila ofertou aceita pela fila; o OUTRO manda a proposta manual
      // (permitido: a fila do broadcast é NÃO-exclusiva).
      const oG = await api("GET", "/api/motorista/oferta-atual", { token: tokDbG });
      const oH = await api("GET", "/api/motorista/oferta-atual", { token: tokDbH });
      const gOfertado = oG.json && oG.json.pedido_id === pedidoId;
      const hOfertado = oH.json && oH.json.pedido_id === pedidoId;
      assert(gOfertado || hOfertado, "a fila deveria ter ofertado a um dos dois motoristas");
      const filaTok = gOfertado ? tokDbG : tokDbH;
      const ofertaId = gOfertado ? oG.json.id : oH.json.id;
      const propTok = gOfertado ? tokDbH : tokDbG;
      const prop = await api("POST", "/api/propostas", { token: propTok, body: { pedido_id: pedidoId } });
      eq(prop.status, 200, "proposta manual criada");
      const propostaId = prop.json.id;
      // DISPARO SIMULTÂNEO: motorista aceita pela fila E passageiro aceita a proposta.
      const [rFila, rProp] = await Promise.all([
        api("POST", `/api/pedido-fila/${ofertaId}/aceitar`, { token: filaTok }),
        api("POST", `/api/propostas/${propostaId}/aceitar`, { token: tokDbP }),
      ]);
      // Exatamente um 200; o perdedor recebe erro claro (409 do gate, ou 404 por
      // o pedido já não estar 'aberto') — jamais os dois vencendo.
      const oks = [rFila.status, rProp.status].filter((s) => s === 200);
      eq(oks.length, 1, "exatamente um aceite deveria vencer");
      const perdedor = rFila.status === 200 ? rProp.status : rFila.status;
      assert(perdedor === 409 || perdedor === 404, `o perdedor deveria receber 409/404, veio ${perdedor}`);
      // Prova de fogo: UMA viagem só para o pedido, e o pedido fica 'atendido'.
      const pg = pgTeste();
      try {
        const v = await pg.query("SELECT COUNT(*)::int AS n FROM viagens WHERE pedido_id = $1", [pedidoId]);
        eq(v.rows[0].n, 1, "deveria existir exatamente UMA viagem para o pedido (sem double-booking)");
        const p = await pg.query("SELECT status FROM pedidos WHERE id = $1", [pedidoId]);
        eq(p.rows[0].status, "atendido", "pedido deveria terminar 'atendido'");
      } finally { await pg.end(); }
    });

    /* ============= OFERTA ÚNICA NA FILA: sem oferta dupla nem pulo ============= */
    // A seleção+oferta virou um único UPDATE (FOR UPDATE SKIP LOCKED + guarda de
    // oferta viva): respostas concorrentes à mesma oferta avançam a fila UMA vez
    // só (nunca dois motoristas ofertados ao mesmo tempo, nunca um candidato
    // pulado), e o "fila esgotada" só vale quando não há aguardando NEM oferta viva.
    grupo("Oferta única na fila: sem oferta dupla nem candidato pulado");
    const OD_ORIG = { lat: -6.300000, lng: -50.500000 };
    const OD_DEST = { lat: -6.320000, lng: -50.540000 };
    const uOdA = novoUsuario(43, "S11D");
    const uOdB = novoUsuario(44, "S11D");
    const uOdC = novoUsuario(45, "S11D");
    const uOdP = novoUsuario(46, "S11D");
    let tokOdA, tokOdB, tokOdC, tokOdP, pedidoOdId;
    const tokensOd = () => [tokOdA, tokOdB, tokOdC];

    async function contarFilaOd(pedidoId) {
      const pg = pgTeste();
      try {
        const r = await pg.query(
          `SELECT COUNT(*) FILTER (WHERE status = 'aguardando')::int AS aguardando,
                  COUNT(*) FILTER (WHERE status = 'ofertada' AND expira_em > NOW())::int AS vivas,
                  COUNT(*) FILTER (WHERE status = 'recusada')::int AS recusadas
           FROM pedido_fila WHERE pedido_id = $1`,
          [pedidoId]
        );
        return r.rows[0];
      } finally { await pg.end(); }
    }
    async function tokenOfertadoOd(pedidoId) {
      for (const tok of tokensOd()) {
        const r = await api("GET", "/api/motorista/oferta-atual", { token: tok });
        if (r.json && r.json.pedido_id === pedidoId) return { tok, ofertaId: r.json.id };
      }
      return null;
    }

    await test("recusa concorrente da mesma oferta avança a fila UMA vez (sem oferta dupla)", async () => {
      for (const [u, set] of [
        [uOdA, (t) => (tokOdA = t)], [uOdB, (t) => (tokOdB = t)],
        [uOdC, (t) => (tokOdC = t)], [uOdP, (t) => (tokOdP = t)],
      ]) {
        const r = await api("POST", "/api/register", { body: u });
        eq(r.status, 200, "registro");
        set(r.json.token);
      }
      for (const tok of tokensOd()) {
        const h = await api("POST", "/api/habilitacao", {
          token: tok,
          body: { placa: "ODF" + Math.floor(Math.random() * 9000 + 1000), tag: "OfertaUnica",
            foto_carro_url: CARRO, foto_carro_em: nowISO(), selfie_url: SELFIE, selfie_em: nowISO() },
        });
        eq(h.status, 200, "habilitação");
        const on = await api("POST", "/api/motorista/online", { token: tok, body: { lat: OD_ORIG.lat, lng: OD_ORIG.lng } });
        eq(on.status, 200, "online");
      }
      const ped = await api("POST", "/api/pedidos", {
        token: tokOdP,
        body: {
          origem_texto: "Origem OD", origem_lat: OD_ORIG.lat, origem_lng: OD_ORIG.lng,
          destino_texto: "Destino OD", destino_lat: OD_DEST.lat, destino_lng: OD_DEST.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1,
        },
      });
      eq(ped.status, 200, "status pedido");
      pedidoOdId = ped.json.id;
      await dormir(300);
      const primeiro = await tokenOfertadoOd(pedidoOdId);
      assert(primeiro, "a fila deveria ter ofertado ao primeiro colocado");
      // O motorista da vez recusa pelos DOIS caminhos ao mesmo tempo (modal da fila
      // + recusa pelo pulso): não pode virar oferta dupla nem pular candidato.
      await Promise.all([
        api("POST", `/api/pedido-fila/${primeiro.ofertaId}/recusar`, { token: primeiro.tok }),
        api("POST", `/api/pedidos/${pedidoOdId}/recusar-motorista`, { token: primeiro.tok }),
      ]);
      await dormir(300);
      const c = await contarFilaOd(pedidoOdId);
      eq(c.vivas, 1, "só pode haver UMA oferta viva depois da recusa (nada de oferta dupla)");
      eq(c.aguardando, 1, "o terceiro colocado deveria seguir aguardando (candidato não pulado)");
      assert(c.recusadas >= 1, "o motorista que recusou deveria contar como recusa");
      const segundo = await tokenOfertadoOd(pedidoOdId);
      assert(segundo && segundo.tok !== primeiro.tok, "a vez deveria passar para o PRÓXIMO da fila");
    });

    await test("quando o último recusa, o passageiro vê a fila esgotada (atual=null), sem oferta fantasma", async () => {
      // Recusa os que sobraram, um de cada vez, até esgotar a fila.
      for (let i = 0; i < 3; i++) {
        const atual = await tokenOfertadoOd(pedidoOdId);
        if (!atual) break;
        await api("POST", `/api/pedido-fila/${atual.ofertaId}/recusar`, { token: atual.tok });
        await dormir(200);
      }
      const c = await contarFilaOd(pedidoOdId);
      eq(c.vivas, 0, "não deveria sobrar oferta viva");
      eq(c.aguardando, 0, "não deveria sobrar ninguém aguardando");
      const fs = await api("GET", `/api/pedidos/${pedidoOdId}/fila-status`, { token: tokOdP });
      eq(fs.status, 200, "status fila-status");
      eq(fs.json.atual, null, "fila esgotada: nenhum motorista sendo chamado (sem oferta fantasma)");
    });

    /* ============= ENCAIXE À FRENTE DO EMBARQUE (carro não volta) ============= */
    // O ponto em comum precisa estar À FRENTE de onde o passageiro embarca na rota
    // do motorista. Antes, um ponto ATRÁS do embarque (que o carro já passou) podia
    // ser ofertado como encaixe — e o carro não volta. Geometria calculada sobre o
    // catálogo real S11D (Portaria -> Bombeiros/Mina): o cluster "Usina" fica em
    // t≈0.3 do corredor; com o passageiro embarcando em t≈0.5, esse cluster está
    // ATRÁS e não pode virar encaixe. (O caso positivo — encaixe à frente — já é
    // coberto pelo grupo "Ponto em comum".)
    grupo("Encaixe à frente do embarque: ponto atrás não é ofertado");
    const EMB_CAR_ORIG = { lat: -6.454156, lng: -50.208344 };  // Portaria S11D (início da rota do motorista)
    const EMB_CAR_DEST = { lat: -6.415464, lng: -50.320819 };  // Bombeiros 09 — Mina (fim da rota)
    const EMB_PAX_ORIG = { lat: -6.434810, lng: -50.264581 };  // embarque em t≈0.5 do corredor (à frente do cluster Usina)
    const EMB_PAX_DEST = { lat: -6.479156, lng: -50.233344 };  // destino "atrás", puxa o cluster Usina como encaixe (proibido)
    const uEmbMot = novoUsuario(47, "S11D");
    const uEmbPax = novoUsuario(48, "S11D");
    let tokEmbMot, tokEmbPax;
    await test("motorista é chamado, mas SEM encaixe (o único ponto em comum ficou atrás)", async () => {
      for (const [u, set] of [[uEmbMot, (t) => (tokEmbMot = t)], [uEmbPax, (t) => (tokEmbPax = t)]]) {
        const r = await api("POST", "/api/register", { body: u });
        eq(r.status, 200, "registro");
        set(r.json.token);
      }
      const h = await api("POST", "/api/habilitacao", {
        token: tokEmbMot,
        body: { placa: "EMB" + Math.floor(Math.random() * 9000 + 1000), tag: "Embarque",
          foto_carro_url: CARRO, foto_carro_em: nowISO(), selfie_url: SELFIE, selfie_em: nowISO() },
      });
      eq(h.status, 200, "habilitação");
      // Publica a rota Portaria -> Bombeiros e fica disponível na Portaria.
      const rCar = await api("POST", "/api/caronas", {
        token: tokEmbMot,
        body: {
          origem_texto: "Portaria S11D", origem_lat: EMB_CAR_ORIG.lat, origem_lng: EMB_CAR_ORIG.lng,
          destino_texto: "Bombeiros 09 — Mina", destino_lat: EMB_CAR_DEST.lat, destino_lng: EMB_CAR_DEST.lng,
          vagas: 2,
        },
      });
      eq(rCar.status, 200, "carona");
      const rLoc = await api("POST", "/api/localizacao", {
        token: tokEmbMot, body: { lat: EMB_CAR_ORIG.lat, lng: EMB_CAR_ORIG.lng, disponivel: true },
      });
      eq(rLoc.status, 200, "localização");
      // Passageiro embarca em t≈0.5 (à frente do cluster Usina) e vai para um destino
      // que, sem a trava, faria o robô ofertar um ponto ATRÁS do embarque.
      const ped = await api("POST", "/api/pedidos", {
        token: tokEmbPax,
        body: {
          origem_texto: "Embarque meio-rota", origem_lat: EMB_PAX_ORIG.lat, origem_lng: EMB_PAX_ORIG.lng,
          destino_texto: "Destino atrás", destino_lat: EMB_PAX_DEST.lat, destino_lng: EMB_PAX_DEST.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1,
        },
      });
      eq(ped.status, 200, "status pedido");
      await dormir(300);
      const oferta = await api("GET", "/api/motorista/oferta-atual", { token: tokEmbMot });
      // O motorista É chamado (candidato pela proximidade da rota) — garante que o
      // caminho de encaixe rodou e não passou batido por falta de candidato...
      assert(oferta.json && oferta.json.pedido_id === ped.json.id,
        "o motorista deveria ser chamado para o pedido (candidato pela rota)");
      // ...mas NÃO pode trazer encaixe: o único ponto em comum ficou atrás do embarque.
      assert(!oferta.json.encaixe_texto,
        "não deveria ofertar encaixe num ponto atrás do embarque (o carro não volta)");
    });

    /* ============= PEDIDO AGENDADO ATIVA BUSCA NÃO-EXCLUSIVA ============= */
    // Ao chegar o horário, o pedido agendado deve entrar com a MESMA busca do
    // pedido imediato (fila NÃO-exclusiva): pulso visível no mapa e propostas
    // manuais liberadas. A fila EXCLUSIVA antiga escondia o pedido e travava
    // ofertas manuais com 400 "busca automática por proximidade".
    grupo("Pedido agendado: ativa busca não-exclusiva (pulso visível, proposta liberada)");
    const AG_ORIG = { lat: -6.200000, lng: -50.600000 };
    const AG_DEST = { lat: -6.220000, lng: -50.640000 };
    const uAgMot = novoUsuario(49, "S11D");   // motorista candidato (na origem)
    const uAgMot2 = novoUsuario(50, "S11D");  // motorista que testa a proposta manual
    const uAgPax = novoUsuario(51, "S11D");   // passageiro que agenda
    let tokAgMot, tokAgMot2, tokAgPax;
    await test("agendado que venceu o horário entra com fila não-exclusiva e aceita proposta manual", async () => {
      for (const [u, set] of [[uAgMot, (t) => (tokAgMot = t)], [uAgMot2, (t) => (tokAgMot2 = t)], [uAgPax, (t) => (tokAgPax = t)]]) {
        const r = await api("POST", "/api/register", { body: u });
        eq(r.status, 200, "registro");
        set(r.json.token);
      }
      for (const tok of [tokAgMot, tokAgMot2]) {
        const h = await api("POST", "/api/habilitacao", {
          token: tok,
          body: { placa: "AGD" + Math.floor(Math.random() * 9000 + 1000), tag: "Agendado",
            foto_carro_url: CARRO, foto_carro_em: nowISO(), selfie_url: SELFIE, selfie_em: nowISO() },
        });
        eq(h.status, 200, "habilitação");
      }
      // Só o candidato (uAgMot) fica online na origem — uAgMot2 apenas oferta manual.
      const on = await api("POST", "/api/motorista/online", { token: tokAgMot, body: { lat: AG_ORIG.lat, lng: AG_ORIG.lng } });
      eq(on.status, 200, "online");
      // Agenda para o próximo minuto (futuro): não dispara fila na hora, notificado=FALSE.
      const quando = new Date(Date.now() + 90 * 1000);
      const p2 = (n) => String(n).padStart(2, "0");
      const horario = `${quando.getFullYear()}-${p2(quando.getMonth() + 1)}-${p2(quando.getDate())}T${p2(quando.getHours())}:${p2(quando.getMinutes())}`;
      const ped = await api("POST", "/api/pedidos", {
        token: tokAgPax,
        body: {
          origem_texto: "Origem AG", origem_lat: AG_ORIG.lat, origem_lng: AG_ORIG.lng,
          destino_texto: "Destino AG", destino_lat: AG_DEST.lat, destino_lng: AG_DEST.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1, horario,
        },
      });
      eq(ped.status, 200, "status pedido agendado");
      const pedidoId = ped.json.id;
      assert(ped.json.agendado_futuro, "pedido deveria nascer agendado para o futuro");
      // Simula a chegada do horário (como o teste de GPS envelhece o relógio):
      // recua o horário para o passado; o agendador (500 ms) ativa no próximo tick.
      const pg = pgTeste();
      try {
        await pg.query("UPDATE pedidos SET horario = NOW() - INTERVAL '1 minute' WHERE id = $1", [pedidoId]);
      } finally { await pg.end(); }
      await dormir(900);
      // Ativou? notificado=TRUE e há fila — e ela é NÃO-exclusiva.
      const pg2 = pgTeste();
      try {
        const f = await pg2.query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE exclusiva)::int AS exclusivas
           FROM pedido_fila WHERE pedido_id = $1`,
          [pedidoId]
        );
        assert(f.rows[0].total > 0, "o agendador deveria ter criado a fila do pedido");
        eq(f.rows[0].exclusivas, 0, "a fila do agendado deveria ser NÃO-exclusiva");
      } finally { await pg2.end(); }
      // Prova de comportamento: proposta manual de outro motorista é LIBERADA
      // (fila exclusiva antiga devolveria 400).
      const prop = await api("POST", "/api/propostas", { token: tokAgMot2, body: { pedido_id: pedidoId } });
      eq(prop.status, 200, "proposta manual deveria ser aceita (fila não-exclusiva)");
      // E o pulso continua visível no mapa de um motorista perto.
      const mapa = await api("GET", `/api/pedidos?lat=${AG_ORIG.lat}&lng=${AG_ORIG.lng}`, { token: tokAgMot2 });
      eq(mapa.status, 200, "status mapa");
      assert(Array.isArray(mapa.json) && mapa.json.some((p) => p.id === pedidoId),
        "o pulso do agendado deveria aparecer no mapa (fila não-exclusiva não esconde)");
    });

    /* =================== LOCALIZAÇÃO AO VIVO =================== */
    grupo("Localização ao vivo");
    await test("POST /api/localizacao aceita coordenadas válidas", async () => {
      const { status } = await api("POST", "/api/localizacao", {
        token: tokDriver, body: { lat: ORIGEM.lat, lng: ORIGEM.lng, disponivel: true },
      });
      eq(status, 200, "status");
    });
    await test("POST /api/localizacao rejeita coordenadas inválidas → 400", async () => {
      const { status } = await api("POST", "/api/localizacao", {
        token: tokDriver, body: { lat: 999, lng: 999 },
      });
      eq(status, 400, "status");
    });

    /* =================== ADMIN =================== */
    grupo("Painel admin (000000 / admin123)");
    let tokAdmin;
    await test("login admin 000000", async () => {
      const { status, json } = await api("POST", "/api/login", {
        body: { matricula: "000000", senha: "admin123" },
      });
      eq(status, 200, "status");
      assert(json.user.is_admin, "não veio is_admin");
      tokAdmin = json.token;
    });
    await test("não-admin é barrado no overview → 403", async () => {
      const { status } = await api("GET", "/api/admin/overview", { token: tokDriver });
      eq(status, 403, "status");
    });
    await test("GET /api/admin/overview (admin) → 200", async () => {
      const { status } = await api("GET", "/api/admin/overview", { token: tokAdmin });
      eq(status, 200, "status");
    });
    await test("GET /api/admin/metricas (admin) → 200", async () => {
      const { status } = await api("GET", "/api/admin/metricas", { token: tokAdmin });
      eq(status, 200, "status");
    });
    await test("GET /api/admin/rateio (admin) → 200", async () => {
      const { status } = await api("GET", "/api/admin/rateio", { token: tokAdmin });
      eq(status, 200, "status");
    });
    await test("GET /api/admin/rateio/export (admin) → 200 xlsx", async () => {
      const r = await fetch(`${BASE}/api/admin/rateio/export`, {
        headers: { Authorization: `Bearer ${tokAdmin}` },
      });
      eq(r.status, 200, "status");
      const ct = r.headers.get("content-type") || "";
      assert(ct.includes("spreadsheetml"), `content-type xlsx, veio ${ct}`);
      const buf = await r.arrayBuffer();
      assert(buf.byteLength > 2000, `arquivo muito pequeno (${buf.byteLength} bytes)`);
    });
    await test("GET /api/admin/seguranca (admin) → 200", async () => {
      const { status } = await api("GET", "/api/admin/seguranca", { token: tokAdmin });
      eq(status, 200, "status");
    });
    await test("admin desativa e reativa usuário do projeto", async () => {
      let r = await api("POST", `/api/admin/usuarios/${encodeURIComponent(uPax.matricula)}/desativar`, {
        token: tokAdmin, body: { motivo: "Teste integração" },
      });
      eq(r.status, 200, "status desativar");

      r = await api("POST", "/api/login", { body: { matricula: uPax.matricula, senha: uPax.senha } });
      eq(r.status, 401, "login bloqueado após desativar");

      r = await api("POST", `/api/admin/usuarios/${encodeURIComponent(uPax.matricula)}/reativar`, {
        token: tokAdmin, body: {},
      });
      eq(r.status, 200, "status reativar");

      r = await api("POST", "/api/login", { body: { matricula: uPax.matricula, senha: uPax.senha } });
      eq(r.status, 200, "login ok após reativar");
      // Sessão única: o re-login invalidou o tokPax antigo — adota o novo.
      if (r.json && r.json.token) tokPax = r.json.token;
    });

    /* =================== CHAMADOS DE ACESSO ADMIN (fila de aprovação) =================== */
    grupo("Chamados de acesso admin (aprovar cria o admin do projeto)");
    const uChamado = novoUsuario(31, "S11D");
    const uChamado2 = novoUsuario(32, "S11D");
    let chamadoId;
    await test("POST /api/admin/chamados (público) cria solicitação", async () => {
      const { status } = await api("POST", "/api/admin/chamados", {
        body: {
          nome: uChamado.nome, matricula: uChamado.matricula, empresa_nome: uChamado.empresa_nome,
          projeto_codigo: "S11D", telefone: uChamado.telefone, email: uChamado.email,
          justificativa: "Teste de integração",
        },
      });
      eq(status, 200, "status");
    });
    await test("mesma matrícula com chamado pendente → 400", async () => {
      const { status } = await api("POST", "/api/admin/chamados", {
        body: {
          nome: uChamado.nome, matricula: uChamado.matricula, projeto_codigo: "S11D",
          telefone: uChamado.telefone, email: uChamado.email,
        },
      });
      eq(status, 400, "status");
    });
    await test("GET /api/admin/chamados exige admin (motorista → 403)", async () => {
      const { status } = await api("GET", "/api/admin/chamados", { token: tokDriver });
      eq(status, 403, "status");
    });
    await test("GET /api/admin/chamados lista o pendente do projeto", async () => {
      const { status, json } = await api("GET", "/api/admin/chamados?status=pendente", { token: tokAdmin });
      eq(status, 200, "status");
      const c = json.find((x) => x.matricula === uChamado.matricula);
      assert(c, "chamado não apareceu na fila do admin");
      chamadoId = c.id;
    });
    await test("aprovar chamado cria o admin (senha inicial 123456)", async () => {
      const { status } = await api("POST", `/api/admin/chamados/${chamadoId}/aprovar`, { token: tokAdmin });
      eq(status, 200, "status aprovar");
      const r = await api("POST", "/api/login", {
        body: { matricula: uChamado.matricula, senha: "123456" },
      });
      eq(r.status, 200, "login do novo admin");
      assert(r.json.user.is_admin, "aprovado deveria ser admin");
    });
    await test("chamado já processado não pode ser reaprovado (404)", async () => {
      const { status } = await api("POST", `/api/admin/chamados/${chamadoId}/aprovar`, { token: tokAdmin });
      eq(status, 404, "status");
    });
    await test("recusar chamado move para a lista de recusados", async () => {
      let r = await api("POST", "/api/admin/chamados", {
        body: {
          nome: uChamado2.nome, matricula: uChamado2.matricula, projeto_codigo: "S11D",
          telefone: uChamado2.telefone, email: uChamado2.email,
        },
      });
      eq(r.status, 200, "status criar");
      r = await api("GET", "/api/admin/chamados?status=pendente", { token: tokAdmin });
      const c = r.json.find((x) => x.matricula === uChamado2.matricula);
      assert(c, "segundo chamado na fila");
      r = await api("POST", `/api/admin/chamados/${c.id}/recusar`, { token: tokAdmin });
      eq(r.status, 200, "status recusar");
      r = await api("GET", "/api/admin/chamados?status=recusado", { token: tokAdmin });
      assert(r.json.some((x) => x.matricula === uChamado2.matricula), "deveria estar em recusados");
    });

    /* =================== LGPD: consentimento de usuário existente =================== */
    grupo("LGPD — aceite de usuário já cadastrado (portão)");
    await test("usuário legado (sem aceite) tem politica_pendente=true e aceita depois", async () => {
      // Simula um usuário cadastrado ANTES da política: zera o aceite direto no banco.
      const pg = pgTeste();
      try {
        await pg.query(
          "UPDATE usuarios SET politica_aceita_em = NULL, politica_versao = NULL WHERE matricula = $1",
          [uPax.matricula]
        );
      } finally {
        await pg.end();
      }

      let r = await api("GET", "/api/perfil", { token: tokPax });
      eq(r.status, 200, "status perfil");
      eq(r.json.politica_pendente, true, "deveria estar pendente após zerar o aceite");

      r = await api("POST", "/api/perfil/aceitar-politica", { token: tokPax, body: { politica_versao: "1.0" } });
      eq(r.status, 200, "status aceite");
      eq(r.json.politica_pendente, false, "após aceitar, não deve mais estar pendente");

      r = await api("GET", "/api/perfil", { token: tokPax });
      eq(r.json.politica_pendente, false, "perfil deve refletir o aceite persistido");
    });

    /* =================== RECUPERAÇÃO DE SENHA (email + link) =================== */
    grupo("Recuperação de senha (token por email)");
    await test("solicitar com email que não confere → 200 genérico (não vaza cadastro)", async () => {
      const { status, json } = await api("POST", "/api/recuperar-senha/solicitar", {
        body: { matricula: uPax.matricula, email: "nao-eh-o-email@example.com" },
      });
      eq(status, 200, "status");
      assert(json.success, "resposta genérica de sucesso");
    });
    await test("solicitar com dados corretos grava token pendente no banco", async () => {
      // Sem RESEND_API_KEY (fora de produção) o envio é pulado, mas o token nasce.
      const { status } = await api("POST", "/api/recuperar-senha/solicitar", {
        body: { matricula: uPax.matricula, email: uPax.email },
      });
      eq(status, 200, "status");
      const pg = pgTeste();
      try {
        const { rows } = await pg.query(
          `SELECT t.id FROM tokens_recuperacao t
           JOIN usuarios u ON u.id = t.usuario_id
           WHERE u.matricula = $1 AND t.usado = FALSE AND t.expira_em > NOW()`,
          [uPax.matricula]
        );
        eq(rows.length, 1, "um token pendente");
      } finally { await pg.end(); }
    });
    await test("confirmar com token inválido → 400", async () => {
      const { status } = await api("POST", "/api/recuperar-senha/confirmar", {
        body: { token: "deadbeef".repeat(8), nova_senha: "654321" },
      });
      eq(status, 400, "status");
    });
    await test("confirmar exige senha de 6 dígitos → 400", async () => {
      const { status } = await api("POST", "/api/recuperar-senha/confirmar", {
        body: { token: "qualquer", nova_senha: "abc" },
      });
      eq(status, 400, "status");
    });
    await test("confirmar troca a senha; token não pode ser reusado", async () => {
      // O servidor guarda só o SHA-256 do token: injeta um token conhecido no
      // banco de teste, como o email teria entregado ao usuário.
      const token = crypto.randomBytes(32).toString("hex");
      const hash = crypto.createHash("sha256").update(token).digest("hex");
      const pg = pgTeste();
      try {
        await pg.query(
          `INSERT INTO tokens_recuperacao (usuario_id, token_hash, expira_em)
           SELECT id, $2, NOW() + INTERVAL '1 hour' FROM usuarios WHERE matricula = $1`,
          [uPax.matricula, hash]
        );
      } finally { await pg.end(); }

      let r = await api("POST", "/api/recuperar-senha/confirmar", {
        body: { token, nova_senha: "654321" },
      });
      eq(r.status, 200, "status confirmar");

      r = await api("POST", "/api/login", {
        body: { matricula: uPax.matricula, senha: "654321" },
      });
      eq(r.status, 200, "login com a senha nova");
      uPax.senha = "654321";
      // Sessão única: login novo rotaciona o token do passageiro.
      if (r.json && r.json.token) tokPax = r.json.token;

      r = await api("POST", "/api/recuperar-senha/confirmar", {
        body: { token, nova_senha: "111111" },
      });
      eq(r.status, 400, "token usado não vale de novo");
    });

    /* =================== MATCH PRÓXIMO S11D (Portaria vs Central) =================== */
    grupo("Match proximo S11D (Portaria vs Central)");
    const PORTARIA_S11D = { lat: -6.454156, lng: -50.208344, texto: "Portaria S11D" };
    const CENTRAL_S11D = { lat: -6.438503, lng: -50.232414, texto: "Central de Operações S11D" };
    // Origem a LESTE da Portaria: a Central (~3,2 km do destino) fica fora do
    // corredor da rota (não vira "total") e cai no raio próximo (4 km) → buzina.
    // Vindo do oeste (-50.24) a linha reta passava a ~1,3 km da Central e o
    // corredor de 2 km classificava como "total", que bloqueia a buzina.
    const ORIGEM_S11D = { lat: -6.449, lng: -50.18 };

    await test("motorista publica carona para Portaria S11D", async () => {
      const { status, json } = await api("POST", "/api/caronas", {
        token: tokDriver,
        body: {
          origem_texto: "Usina", origem_lat: ORIGEM_S11D.lat, origem_lng: ORIGEM_S11D.lng,
          destino_texto: PORTARIA_S11D.texto, destino_lat: PORTARIA_S11D.lat, destino_lng: PORTARIA_S11D.lng,
          vagas: 2,
        },
      });
      eq(status, 200, "status");
      caronaId = json.id;
    });
    await test("GET /api/caronas?dest=Central marca proximo (Portaria ~3 km)", async () => {
      const q = `?lat=${ORIGEM_S11D.lat}&lng=${ORIGEM_S11D.lng}&dest_lat=${CENTRAL_S11D.lat}&dest_lng=${CENTRAL_S11D.lng}`;
      const { status, json } = await api("GET", "/api/caronas" + q, { token: tokPax });
      eq(status, 200, "status");
      const c = json.find((x) => x.id === caronaId);
      assert(c, "motorista com carona para Portaria deveria aparecer para Central");
      eq(c.compat_rota, "proximo", "compat_rota");
    });
    await test("buzina com mesmo destino da carona → 400", async () => {
      const { status, json } = await api("POST", `/api/motoristas-online/${idDriver}/contato`, {
        token: tokPax,
        body: {
          origem_lat: ORIGEM_S11D.lat, origem_lng: ORIGEM_S11D.lng,
          destino_lat: PORTARIA_S11D.lat, destino_lng: PORTARIA_S11D.lng,
          destino_texto: PORTARIA_S11D.texto,
          pessoas: 1,
        },
      });
      eq(status, 400, "status");
      assert(String(json.error || "").includes("Solicitar vaga"), "mensagem");
    });
    await test("buzina para Central cria contato proximo visível no mapa", async () => {
      const { status, json } = await api("POST", `/api/motoristas-online/${idDriver}/contato`, {
        token: tokPax,
        body: {
          origem_lat: ORIGEM_S11D.lat, origem_lng: ORIGEM_S11D.lng,
          destino_lat: CENTRAL_S11D.lat, destino_lng: CENTRAL_S11D.lng,
          destino_texto: CENTRAL_S11D.texto,
          pessoas: 1,
        },
      });
      eq(status, 200, "status");
      assert(json.contato_id, "contato_id");
      const { status: s2, json: mapa } = await api("GET", "/api/motorista/contatos/mapa", { token: tokDriver });
      eq(s2, 200, "status mapa");
      const c = mapa.find((x) => x.id === json.contato_id);
      assert(c, "contato no mapa");
      eq(c.compat_rota, "proximo", "compat_rota contato");
      eq(c.destino_texto, CENTRAL_S11D.texto, "destino passageiro");
      assert(c.destino_motorista_texto, "destino motorista");
    });
    await test("contatos/mapa não mostra buzina redundante (mesmo destino da carona)", async () => {
      await api("POST", `/api/motoristas-online/${idDriver}/contato`, {
        token: tokPax,
        body: {
          origem_lat: ORIGEM_S11D.lat, origem_lng: ORIGEM_S11D.lng,
          destino_lat: PORTARIA_S11D.lat, destino_lng: PORTARIA_S11D.lng,
          destino_texto: PORTARIA_S11D.texto,
          pessoas: 1,
        },
      });
      const { status, json } = await api("GET", "/api/motorista/contatos/mapa", { token: tokDriver });
      eq(status, 200, "status");
      assert(!json.some((x) => x.destino_texto === PORTARIA_S11D.texto), "pulso fantasma mesmo destino");
    });

    /* =================== ANTI-FORÇA-BRUTA (rate limit) =================== */
    // Deve rodar por ÚLTIMO: estoura de propósito o teto de tentativas de login.
    grupo("Anti-força-bruta no login (rate limit)");
    await test("excesso de tentativas de login retorna 429", async () => {
      let viu429 = false;
      for (let i = 0; i < 40; i++) {
        const { status } = await api("POST", "/api/login", {
          body: { matricula: "999999", senha: "000000" },
        });
        if (status === 429) { viu429 = true; break; }
      }
      assert(viu429, "esperava um 429 após muitas tentativas de login");
    });

  } finally {
    server.kill("SIGKILL");
  }

  /* ------------------------------- resumo ------------------------------- */
  console.log(`\n${"─".repeat(48)}`);
  console.log(`\x1b[1mResultado:\x1b[0m ${passed} passaram, ${failed} falharam de ${passed + failed}`);
  if (failed) {
    console.log("\n\x1b[31mFalhas:\x1b[0m");
    falhas.forEach((f) => console.log(`  • ${f.nome}: ${f.erro}`));
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("Erro fatal no runner:", e);
  process.exit(1);
});
