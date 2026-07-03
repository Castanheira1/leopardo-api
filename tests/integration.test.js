#!/usr/bin/env node
/*
 * Teste de integração ponta-a-ponta do Vagão.
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
    await test("GET /api/caronas?meus lista a carona do motorista", async () => {
      const { status, json } = await api("GET", "/api/caronas?meus=1", { token: tokDriver });
      eq(status, 200, "status");
      assert(json.some((c) => c.id === caronaId), "carona não veio em ?meus");
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
      const { status, json } = await api("POST", `/api/viagens/${viagemId}/pontos`, {
        token: tokDriver,
        body: { pontos: [
          { lat: -1.4500, lng: -48.4800 },
          { lat: -1.4450, lng: -48.4600 },
          { lat: -1.4000, lng: -48.4400 },
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
    await test("GET /api/admin/seguranca (admin) → 200", async () => {
      const { status } = await api("GET", "/api/admin/seguranca", { token: tokAdmin });
      eq(status, 200, "status");
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
