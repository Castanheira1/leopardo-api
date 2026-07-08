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
const { Pool } = require("pg");

const PORT = process.env.TEST_PORT || 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || "test-secret-com-mais-de-32-caracteres-aqui-ok";

if (!process.env.DATABASE_URL) {
  console.error("ERRO: defina DATABASE_URL para um Postgres de teste (schema.sql aplicado).");
  process.exit(2);
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
      AUTH_RATE_MAX: "30",        // teto conhecido p/ validar o anti-força-bruta no fim
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
      const pg = new Pool({ connectionString: process.env.DATABASE_URL });
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
      const pg = new Pool({ connectionString: process.env.DATABASE_URL });
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
      const alemPerto = {
        lat: DESTINO.lat + (DESTINO.lat - ORIGEM.lat) * 0.02,
        lng: DESTINO.lng + (DESTINO.lng - ORIGEM.lng) * 0.02,
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
        body: { pontos: [
          { lat: -1.4500, lng: -48.4800, em: Date.now() - 90000 },
          { lat: -1.4450, lng: -48.4600, em: Date.now() - 60000 },
          { lat: -1.4200, lng: -48.4500, em: Date.now() - 30000 },
          { lat: -1.4000, lng: -48.4400, em: Date.now() },
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
    });

    /* =================== LGPD: consentimento de usuário existente =================== */
    grupo("LGPD — aceite de usuário já cadastrado (portão)");
    await test("usuário legado (sem aceite) tem politica_pendente=true e aceita depois", async () => {
      // Simula um usuário cadastrado ANTES da política: zera o aceite direto no banco.
      const pg = new Pool({ connectionString: process.env.DATABASE_URL });
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

    /* =================== MATCH PRÓXIMO S11D (Portaria vs Central) =================== */
    grupo("Match proximo S11D (Portaria vs Central)");
    const PORTARIA_S11D = { lat: -6.454156, lng: -50.208344, texto: "Portaria S11D" };
    const CENTRAL_S11D = { lat: -6.438503, lng: -50.232414, texto: "Central de Operações S11D" };
    const ORIGEM_S11D = { lat: -6.449, lng: -50.24 };

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
