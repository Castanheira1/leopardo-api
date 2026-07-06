#!/usr/bin/env node
/*
 * Simulação de carga: 500 usuários diferentes, 500 "eventos de carona" dentro
 * do polígono do S11D (Serra Sul, Canaã dos Carajás/PA), cobrindo os dois
 * fluxos de motorista do app:
 *
 *   - "Modo amarelo" (motorista online, SEM destino publicado, POST
 *     /api/motorista/online) — vê pedidos próximos (600 m) e OFERECE carona
 *     diretamente a um pedido.
 *   - Carona publicada (POST /api/caronas, COM origem/destino) — passageiro
 *     PEDE uma vaga e o motorista aceita.
 *
 * Sobe um Postgres efêmero local (reaproveita o schema.sql), sobe o próprio
 * server.js como processo filho, dispara o tráfego via fetch nativo (Node
 * >= 22) com concorrência limitada, e ao final imprime um relatório com
 * sucessos, falhas, latências e as dificuldades encontradas no sistema.
 *
 * Uso:
 *   DATABASE_URL=postgres://...  node scripts/simulacao-s11d-500.js
 *   (schema.sql já aplicado; ver scripts/rodar-simulacao-s11d.sh para subir
 *   tudo automaticamente com um Postgres descartável)
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const PORT = process.env.SIM_PORT || 3458;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || "test-secret-com-mais-de-32-caracteres-aqui-ok";
const CONCURRENCY = Number(process.env.SIM_CONCURRENCY || 25);

if (!process.env.DATABASE_URL) {
  console.error("ERRO: defina DATABASE_URL para um Postgres de teste (schema.sql aplicado).");
  process.exit(2);
}

/* ------------------------------- limiter --------------------------------- */
function criarLimiter(concorrencia) {
  let ativos = 0;
  const fila = [];
  const proximo = () => {
    if (ativos >= concorrencia || fila.length === 0) return;
    ativos++;
    const { fn, resolve, reject } = fila.shift();
    fn().then(resolve, reject).finally(() => { ativos--; proximo(); });
  };
  return (fn) => new Promise((resolve, reject) => { fila.push({ fn, resolve, reject }); proximo(); });
}
const limit = criarLimiter(CONCURRENCY);

/* ------------------------------ métricas ---------------------------------- */
const metrica = {
  total: 0,
  ok: 0,
  falhas: 0,
  porPasso: {}, // passo -> { ok, falhas, statusCodes:{}, latencias:[] }
  erros: [], // amostra de erros p/ diagnóstico
};

function registrar(passo, status, ms, erroMsg) {
  metrica.total++;
  const p = metrica.porPasso[passo] || (metrica.porPasso[passo] = { ok: 0, falhas: 0, statusCodes: {}, latencias: [] });
  p.latencias.push(ms);
  p.statusCodes[status] = (p.statusCodes[status] || 0) + 1;
  const sucesso = status >= 200 && status < 300;
  if (sucesso) { metrica.ok++; p.ok++; }
  else {
    metrica.falhas++; p.falhas++;
    if (metrica.erros.length < 60) metrica.erros.push({ passo, status, erro: erroMsg });
  }
  return sucesso;
}

async function api(method, rota, { token, body, passo } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  if (token) headers.Authorization = `Bearer ${token}`;
  const t0 = Date.now();
  let status = 0, json = null;
  try {
    const r = await fetch(`${BASE}${rota}`, { method, headers, body: payload });
    status = r.status;
    const txt = await r.text();
    try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
  } catch (e) {
    status = 0; json = { error: `fetch falhou: ${e.message}` };
  }
  const ms = Date.now() - t0;
  if (passo) registrar(passo, status, ms, status >= 400 ? json?.error || String(json) : undefined);
  return { status, json, ms };
}

/* -------------------------------- boot server ------------------------------ */
function bootServer(env) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), JWT_SECRET, NODE_ENV: "test", ...env },
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
    try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return true; } catch {}
    await new Promise((s) => setTimeout(s, 300));
  }
  return false;
}

/* ------------------------------ geografia S11D ----------------------------- */
// Bounding box extraído de public/locais-favoritos.json (49 locais reais do
// Complexo Serra Sul / S11D, Canaã dos Carajás-PA).
const BBOX = { latMin: -6.466, latMax: -6.396, lngMin: -50.372, lngMax: -50.202 };
const rnd = (min, max) => min + Math.random() * (max - min);
const pontoS11D = () => ({ lat: rnd(BBOX.latMin, BBOX.latMax), lng: rnd(BBOX.lngMin, BBOX.lngMax) });
// Desloca um ponto por até `metros` (distância radial real, não por eixo —
// jitter independente em lat/lng permitiria até metros*sqrt(2) de distância).
function jitterMetros(p, metrosMax) {
  const r = Math.random() * metrosMax;
  const theta = Math.random() * 2 * Math.PI;
  const dLat = (r * Math.cos(theta)) / 111320;
  const dLng = (r * Math.sin(theta)) / (111320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}
function distanciaKm(a, b) {
  const R = 6371, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}
function pontosRota(origem, destino, n = 6) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push({ lat: origem.lat + (destino.lat - origem.lat) * t, lng: origem.lng + (destino.lng - origem.lng) * t });
  }
  return pts;
}

/* --------------------------------- fixtures -------------------------------- */
const SELFIE = "https://example.com/storage/v1/object/public/veiculos/selfies/s.jpg";
const CARRO = "https://example.com/storage/v1/object/public/veiculos/carros/c.jpg";
const nowISO = () => new Date().toISOString();
const uniq = Date.now().toString().slice(-7);

const N_DRIVER_CARONA = Number(process.env.SIM_DRIVER_CARONA || 125);
const N_DRIVER_AMARELO = Number(process.env.SIM_DRIVER_AMARELO || 125);
const N_PASSAGEIRO_CARONA = Number(process.env.SIM_PAX_CARONA || 125);
const N_PASSAGEIRO_AMARELO = Number(process.env.SIM_PAX_AMARELO || 125);
const TOTAL_USUARIOS = N_DRIVER_CARONA + N_DRIVER_AMARELO + N_PASSAGEIRO_CARONA + N_PASSAGEIRO_AMARELO;

const CARROS = ["Gol", "Onix", "HB20", "Corolla", "Strada", "Saveiro", "Tracker", "Duster", "Kicks", "Argo"];
const CORES = ["Prata", "Branco", "Preto", "Vermelho", "Cinza", "Azul"];

function placaAleatoria(i) {
  const letras = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${letras()}${letras()}${letras()}${1000 + (i % 9000)}`.slice(0, 7);
}

function novoUsuario(n) {
  return {
    nome: `Colaborador S11D ${n}`,
    matricula: String(2000000 + Number(uniq.slice(-5)) * 1000 + n).slice(-9),
    senha: "123456",
    telefone: `9490${String(n).padStart(6, "0")}`,
    email: `sim.s11d.${uniq}.${n}@example.com`,
    empresa_nome: n % 3 === 0 ? "Vale S.A." : n % 3 === 1 ? "Empreiteira Serra Sul" : "Contrato Operações S11D",
    projeto_codigo: "S11D",
    centro_custo: `CC-${1000 + (n % 12)}`,
    sexo: n % 2 ? "M" : "F",
    aceite_politica: true,
    politica_versao: "1.0",
  };
}

/* --------------------------- controle: rate-limit --------------------------- */
// Mede empiricamente onde o limitador GLOBAL (padrão: 1200 req/15min por IP)
// interrompe o tráfego, usando só GETs públicos (sem custo de banco), ANTES de
// rodar a simulação completa (que roda com RATE_LIMIT_MAX elevado, documentado
// no relatório, já que 500 clientes de um teste real usariam 500 IPs distintos
// — aqui todos saem do mesmo IP de loopback).
async function testeControleRateLimitPadrao() {
  const child = bootServer({ RATE_LIMIT_MAX: "" }); // "" -> cai no default do server (1200)
  delete child.spawnargs; // no-op, só evita lint de var não usada
  const up = await esperarUp();
  if (!up) { child.kill("SIGKILL"); return { erro: "servidor de controle não subiu" }; }
  let primeiro429 = null;
  const N = 1260;
  for (let i = 1; i <= N; i++) {
    const r = await fetch(`${BASE}/api/config`);
    if (r.status === 429 && primeiro429 === null) { primeiro429 = i; break; }
  }
  child.kill("SIGKILL");
  await new Promise((s) => setTimeout(s, 400));
  return { primeiro429, tentativas: N };
}

/* ----------------------------------- main ----------------------------------- */
(async () => {
  console.log(`\n${"=".repeat(70)}`);
  console.log("SIMULAÇÃO — 500 usuários / caronas no S11D (Serra Sul, Canaã dos Carajás-PA)");
  console.log("=".repeat(70));

  console.log("\n[controle] medindo o limitador global padrão (1200 req/15min por IP)...");
  const controle = await testeControleRateLimitPadrao();
  if (controle.erro) console.log(`  aviso: ${controle.erro}`);
  else if (controle.primeiro429) console.log(`  429 apareceu na requisição #${controle.primeiro429} de ${controle.tentativas} (GET /api/config, mesmo IP).`);
  else console.log(`  nenhum 429 em ${controle.tentativas} requisições (inesperado).`);

  console.log("\n[boot] subindo server.js para a simulação principal (RATE_LIMIT_MAX elevado)...");
  const server = bootServer({
    RATE_LIMIT_MAX: "1000000",     // artefato do teste: 500 usuários reais viriam de 500 IPs distintos
    AUTH_RATE_MAX: "1000000",      // idem para login/registro
    RAIO_MATCH_KM: "3",
    RAIO_VISIVEL_KM: "10",
    RAIO_ONLINE_KM: "0.6",
    CORS_ORIGINS: "",
  });
  const up = await esperarUp();
  if (!up) {
    console.error("Servidor não subiu a tempo. Log:\n" + server._log());
    server.kill("SIGKILL");
    process.exit(1);
  }
  console.log(`  servidor no ar em ${BASE}`);

  const inicio = Date.now();
  try {
    /* ============================ 1) CADASTRO ============================ */
    console.log(`\n[1/8] cadastrando ${TOTAL_USUARIOS} usuários (S11D)...`);
    const usuarios = [];
    for (let n = 0; n < TOTAL_USUARIOS; n++) {
      let tipo;
      if (n < N_DRIVER_CARONA) tipo = "driver_carona";
      else if (n < N_DRIVER_CARONA + N_DRIVER_AMARELO) tipo = "driver_amarelo";
      else if (n < N_DRIVER_CARONA + N_DRIVER_AMARELO + N_PASSAGEIRO_CARONA) tipo = "pax_carona";
      else tipo = "pax_amarelo";
      usuarios.push({ n, tipo, fixture: novoUsuario(n) });
    }
    await Promise.all(usuarios.map((u) => limit(async () => {
      const { status, json } = await api("POST", "/api/register", { body: u.fixture, passo: "registro" });
      if (status === 200) { u.token = json.token; u.id = json.user.id; } else { u.erroRegistro = json?.error; }
    })));
    const registrados = usuarios.filter((u) => u.token);
    console.log(`  ${registrados.length}/${TOTAL_USUARIOS} cadastrados com sucesso.`);

    const driversCarona = usuarios.filter((u) => u.tipo === "driver_carona" && u.token);
    const driversAmarelo = usuarios.filter((u) => u.tipo === "driver_amarelo" && u.token);
    const paxCarona = usuarios.filter((u) => u.tipo === "pax_carona" && u.token);
    const paxAmarelo = usuarios.filter((u) => u.tipo === "pax_amarelo" && u.token);

    /* ==================== 2) HABILITAÇÃO (todos os motoristas) =================== */
    console.log(`\n[2/8] habilitando ${driversCarona.length + driversAmarelo.length} motoristas (placa + selfie + foto do carro)...`);
    const todosDrivers = [...driversCarona, ...driversAmarelo];
    await Promise.all(todosDrivers.map((d, i) => limit(async () => {
      const { status } = await api("POST", "/api/habilitacao", {
        token: d.token, passo: "habilitacao",
        body: {
          placa: placaAleatoria(i),
          tag: `${CARROS[i % CARROS.length]} ${CORES[i % CORES.length]}`,
          foto_carro_url: CARRO, foto_carro_em: nowISO(),
          selfie_url: SELFIE, selfie_em: nowISO(),
        },
      });
      d.habilitado = status === 200;
    })));
    console.log(`  ${todosDrivers.filter((d) => d.habilitado).length}/${todosDrivers.length} habilitados.`);

    /* ============ 3) PUBLICAR: caronas com destino + modo amarelo (online) ========= */
    console.log(`\n[3/8] publicando ${driversCarona.length} caronas (destino fixo) e ligando ${driversAmarelo.length} motoristas no modo amarelo (online, sem destino)...`);
    driversCarona.forEach((d, i) => {
      d.origem = pontoS11D();
      let destino = pontoS11D();
      while (distanciaKm(d.origem, destino) < 1) destino = pontoS11D();
      d.destino = destino;
      d.vagas = (i % 5 === 0) ? 3 : (i % 3 === 0 ? 2 : 1); // ~20% com 3 vagas p/ testar decremento de vagas
    });
    driversAmarelo.forEach((d) => { d.online = pontoS11D(); });

    await Promise.all([
      ...driversCarona.filter((d) => d.habilitado).map((d) => limit(async () => {
        const { status, json } = await api("POST", "/api/caronas", {
          token: d.token, passo: "publicar_carona",
          body: {
            origem_texto: "Portaria S11D", origem_lat: d.origem.lat, origem_lng: d.origem.lng,
            destino_texto: "Alojamento/Usina S11D", destino_lat: d.destino.lat, destino_lng: d.destino.lng,
            vagas: d.vagas,
          },
        });
        if (status === 200) d.caronaId = json.id;
      })),
      ...driversAmarelo.filter((d) => d.habilitado).map((d) => limit(async () => {
        const { status } = await api("POST", "/api/motorista/online", {
          token: d.token, passo: "ficar_online_amarelo",
          body: { lat: d.online.lat, lng: d.online.lng, vagas: 1 + (Math.random() < 0.3 ? 1 : 0) },
        });
        d.ficouOnline = status === 200;
      })),
    ]);
    console.log(`  ${driversCarona.filter((d) => d.caronaId).length}/${driversCarona.length} caronas publicadas.`);
    console.log(`  ${driversAmarelo.filter((d) => d.ficouOnline).length}/${driversAmarelo.length} motoristas online (amarelo).`);

    /* ============================ 4) PEDIDOS (passageiros) ============================ */
    console.log(`\n[4/8] publicando ${paxCarona.length + paxAmarelo.length} pedidos de carona...`);
    paxCarona.forEach((p, i) => {
      const d = driversCarona[i % driversCarona.length];
      p.parceiro = d;
      p.origem = jitterMetros(d.origem, rnd(50, 700));
      p.destino = jitterMetros(d.destino, rnd(50, 700));
    });
    paxAmarelo.forEach((p, i) => {
      const d = driversAmarelo[i % driversAmarelo.length];
      p.parceiro = d;
      p.origem = jitterMetros(d.online, rnd(50, 500)); // dentro do raio de 600 m do modo amarelo
      p.destino = pontoS11D();
    });
    const todosPax = [...paxCarona, ...paxAmarelo];
    await Promise.all(todosPax.map((p) => limit(async () => {
      const { status, json } = await api("POST", "/api/pedidos", {
        token: p.token, passo: "publicar_pedido",
        body: {
          origem_texto: "Local do colaborador", origem_lat: p.origem.lat, origem_lng: p.origem.lng,
          destino_texto: "Destino do colaborador", destino_lat: p.destino.lat, destino_lng: p.destino.lng,
          selfie_url: SELFIE, selfie_em: nowISO(), pessoas: 1,
        },
      });
      if (status === 200) p.pedidoId = json.id;
    })));
    console.log(`  ${todosPax.filter((p) => p.pedidoId).length}/${todosPax.length} pedidos publicados.`);

    /* ============ 5) MAPA: motoristas online e caronas por destino são vistos? ============ */
    console.log("\n[5/8] verificando visibilidade no mapa (todos os carros/motoristas)...");
    let vistosCarona = 0, vistosAmarelo = 0;
    await Promise.all([
      ...paxCarona.map((p) => limit(async () => {
        if (!p.parceiro?.caronaId) return;
        const q = `?lat=${p.origem.lat}&lng=${p.origem.lng}&dest_lat=${p.destino.lat}&dest_lng=${p.destino.lng}`;
        const { status, json } = await api("GET", "/api/caronas" + q, { token: p.token, passo: "mapa_ver_carona_destino" });
        if (status === 200 && Array.isArray(json) && json.some((c) => c.id === p.parceiro.caronaId)) { vistosCarona++; p.viuCaronaNoMapa = true; }
      })),
      ...paxAmarelo.map((p) => limit(async () => {
        if (!p.parceiro?.ficouOnline) return;
        const q = `?lat=${p.origem.lat}&lng=${p.origem.lng}`;
        const { status, json } = await api("GET", "/api/motoristas-online" + q, { token: p.token, passo: "mapa_ver_motorista_online" });
        if (status === 200 && Array.isArray(json) && json.some((m) => m.id === p.parceiro.id)) { vistosAmarelo++; p.viuOnlineNoMapa = true; }
      })),
    ]);
    console.log(`  caronas com destino visíveis no mapa do passageiro certo: ${vistosCarona}/${paxCarona.filter((p) => p.parceiro?.caronaId).length}`);
    console.log(`  motoristas "amarelo" (online) vistos no mapa do passageiro certo (600 m): ${vistosAmarelo}/${paxAmarelo.filter((p) => p.parceiro?.ficouOnline).length}`);

    // Contagem GLOBAL (sem lat/lng = sem filtro de raio, só LIMIT 100 do endpoint) — testa "todos os carros no mapa" de uma vez.
    const somaOnlineEsperada = driversCarona.filter((d) => d.caronaId).length + driversAmarelo.filter((d) => d.ficouOnline).length;
    const algumPax = todosPax.find((p) => p.token);
    const { status: statusMapaTotal, json: mapaTotal } = await api("GET", "/api/motoristas-online", { token: algumPax.token, passo: "mapa_listagem_total" });
    const totalNoMapa = (statusMapaTotal === 200 && Array.isArray(mapaTotal)) ? mapaTotal.length : -1;
    console.log(`  listagem geral (sem filtro de raio): ${totalNoMapa} motoristas retornados de ${somaOnlineEsperada} online/ativos esperados (endpoint tem LIMIT 100).`);

    /* ==================== 6) MATCH + PROPOSTA + ACEITE (carona publicada) =================== */
    console.log("\n[6/8] fluxo carona publicada: passageiro pede vaga -> motorista aceita...");
    const paresCarona = paxCarona.filter((p) => p.pedidoId && p.parceiro?.caronaId);
    await Promise.all(paresCarona.map((p) => limit(async () => {
      const { status, json } = await api("POST", "/api/propostas", {
        token: p.token, passo: "proposta_pedir_vaga_carona",
        body: { carona_id: p.parceiro.caronaId, selfie_url: SELFIE, selfie_em: nowISO(), mensagem: "posso ir?" },
      });
      if (status === 200) p.propostaId = json.id;
    })));
    const comProposta1 = paresCarona.filter((p) => p.propostaId);
    await Promise.all(comProposta1.map((p) => limit(async () => {
      const { status, json } = await api("POST", `/api/propostas/${p.propostaId}/aceitar`, {
        token: p.parceiro.token, passo: "aceitar_proposta_carona",
      });
      if (status === 200) p.viagemId = json.viagem_id;
    })));
    console.log(`  ${comProposta1.length}/${paresCarona.length} propostas criadas; ${comProposta1.filter((p) => p.viagemId).length} viagens iniciadas.`);

    // Achado: carona com vagas>1 fica "concluida" (fechada) já no 1º aceite —
    // um 2º passageiro tenta pegar uma das vagas restantes e deve falhar.
    const caronasComSobra = driversCarona.filter((d) => d.caronaId && d.vagas > 1 &&
      paresCarona.some((p) => p.parceiro === d && p.viagemId));
    let vagaSobrandoTestada = 0, vagaSobrandoAindaDisponivel = 0;
    await Promise.all(caronasComSobra.slice(0, 40).map((d) => limit(async () => {
      const outroPax = todosPax.find((p) => p.token && p.parceiro !== d && p.id !== d.id);
      if (!outroPax) return;
      vagaSobrandoTestada++;
      const { status } = await api("POST", "/api/propostas", {
        token: outroPax.token, passo: "checar_vaga_sobrando_apos_1o_aceite",
        body: { carona_id: d.caronaId, selfie_url: SELFIE, selfie_em: nowISO() },
      });
      if (status === 200) vagaSobrandoAindaDisponivel++;
    })));
    console.log(`  vagas restantes testadas após 1º aceite: ${vagaSobrandoTestada} caronas (vagas>1); ainda aceitavam nova proposta: ${vagaSobrandoAindaDisponivel}`);

    /* ================= 7) MODO AMARELO: motorista vê pedido e oferece ================= */
    console.log("\n[7/8] fluxo modo amarelo: motorista online vê pedido perto e oferece carona...");
    const paresAmarelo = paxAmarelo.filter((p) => p.pedidoId && p.parceiro?.ficouOnline);
    await Promise.all(paresAmarelo.map((p) => limit(async () => {
      const d = p.parceiro;
      const q = `?lat=${d.online.lat}&lng=${d.online.lng}`;
      const { status, json } = await api("GET", "/api/pedidos" + q, { token: d.token, passo: "amarelo_ver_pedido_perto" });
      d.vePedidoDoParceiro = status === 200 && Array.isArray(json) && json.some((ped) => ped.id === p.pedidoId);
    })));
    await Promise.all(paresAmarelo.map((p) => limit(async () => {
      if (!p.parceiro.vePedidoDoParceiro) return;
      const { status, json } = await api("POST", "/api/propostas", {
        token: p.parceiro.token, passo: "amarelo_oferecer_carona",
        body: { pedido_id: p.pedidoId },
      });
      if (status === 200) p.propostaId = json.id;
    })));
    const comProposta2 = paresAmarelo.filter((p) => p.propostaId);
    await Promise.all(comProposta2.map((p) => limit(async () => {
      const { status, json } = await api("POST", `/api/propostas/${p.propostaId}/aceitar`, {
        token: p.token, passo: "aceitar_proposta_amarelo",
      });
      if (status === 200) p.viagemId = json.viagem_id;
    })));
    console.log(`  motoristas online que viram o pedido próximo (600 m): ${paresAmarelo.filter((p) => p.parceiro.vePedidoDoParceiro).length}/${paresAmarelo.length}`);
    console.log(`  ${comProposta2.length}/${paresAmarelo.length} propostas de motorista->pedido criadas; ${comProposta2.filter((p) => p.viagemId).length} viagens iniciadas.`);

    /* ==================== 8) VIAGEM: pontos GPS + finalização ==================== */
    console.log("\n[8/8] gravando rota GPS e finalizando as viagens...");
    const viagens = [...paresCarona, ...paresAmarelo].filter((p) => p.viagemId);
    await Promise.all(viagens.map((p) => limit(async () => {
      const motoristaToken = p.parceiro.token;
      const pontos = pontosRota(p.origem, p.destino, 6);
      const { status } = await api("POST", `/api/viagens/${p.viagemId}/pontos`, {
        token: motoristaToken, passo: "gravar_pontos_gps", body: { pontos },
      });
      p.pontosGravados = status === 200;
    })));
    await Promise.all(viagens.map((p) => limit(async () => {
      const motoristaToken = p.parceiro.token;
      const { status, json } = await api("POST", `/api/viagens/${p.viagemId}/finalizar`, {
        token: motoristaToken, passo: "finalizar_viagem",
      });
      if (status === 200) { p.finalizada = true; p.distanciaKm = Number(json.distancia_km); p.deslocamentoValido = json.deslocamento_valido; }
    })));
    const finalizadas = viagens.filter((p) => p.finalizada);
    const validas = finalizadas.filter((p) => p.deslocamentoValido);
    console.log(`  ${finalizadas.length}/${viagens.length} viagens finalizadas (${validas.length} com deslocamento GPS válido).`);

    /* ------------------------------- verificação direta no banco ------------------------------- */
    const pg = new Pool({ connectionString: process.env.DATABASE_URL });
    let contagemBanco = {};
    try {
      const q = async (sql) => (await pg.query(sql)).rows[0].n;
      contagemBanco = {
        usuarios: await q("SELECT COUNT(*) n FROM usuarios WHERE email LIKE 'sim.s11d.%'"),
        habilitacoes: await q("SELECT COUNT(*) n FROM habilitacoes_motorista"),
        caronas: await q("SELECT COUNT(*) n FROM caronas"),
        caronas_concluidas: await q("SELECT COUNT(*) n FROM caronas WHERE status='concluida'"),
        online: await q("SELECT COUNT(*) n FROM localizacoes_online WHERE disponivel=TRUE"),
        pedidos: await q("SELECT COUNT(*) n FROM pedidos"),
        propostas: await q("SELECT COUNT(*) n FROM propostas"),
        propostas_aceitas: await q("SELECT COUNT(*) n FROM propostas WHERE status='aceito'"),
        viagens: await q("SELECT COUNT(*) n FROM viagens"),
        viagens_concluidas: await q("SELECT COUNT(*) n FROM viagens WHERE status='concluida'"),
        viagens_deslocamento_valido: await q("SELECT COUNT(*) n FROM viagens WHERE deslocamento_valido=TRUE"),
      };
    } finally { await pg.end(); }

    const duracaoTotalS = ((Date.now() - inicio) / 1000).toFixed(1);

    /* ---------------------------------- relatório final ---------------------------------- */
    const relatorio = {
      geradoEm: new Date().toISOString(),
      duracaoTotalS: Number(duracaoTotalS),
      concorrencia: CONCURRENCY,
      totalUsuariosAlvo: TOTAL_USUARIOS,
      controleRateLimitPadrao: controle,
      requisicoes: { total: metrica.total, ok: metrica.ok, falhas: metrica.falhas },
      porPasso: Object.fromEntries(Object.entries(metrica.porPasso).map(([k, v]) => {
        const lat = v.latencias.slice().sort((a, b) => a - b);
        const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null;
        return [k, { ok: v.ok, falhas: v.falhas, statusCodes: v.statusCodes, p50ms: pct(0.5), p95ms: pct(0.95), maxMs: lat[lat.length - 1] || null }];
      })),
      funil: {
        usuarios_cadastrados: registrados.length,
        motoristas_habilitados: todosDrivers.filter((d) => d.habilitado).length,
        caronas_publicadas: driversCarona.filter((d) => d.caronaId).length,
        motoristas_amarelo_online: driversAmarelo.filter((d) => d.ficouOnline).length,
        pedidos_publicados: todosPax.filter((p) => p.pedidoId).length,
        vistos_no_mapa_carona: vistosCarona,
        vistos_no_mapa_amarelo: vistosAmarelo,
        listagem_mapa_total_retornada: totalNoMapa,
        listagem_mapa_total_esperada: somaOnlineEsperada,
        propostas_carona: comProposta1.length,
        propostas_amarelo: comProposta2.length,
        viagens_iniciadas: viagens.length,
        viagens_finalizadas: finalizadas.length,
        viagens_deslocamento_valido: validas.length,
        vagas_sobrando_testadas: vagaSobrandoTestada,
        vagas_sobrando_ainda_disponiveis: vagaSobrandoAindaDisponivel,
      },
      contagemBanco,
      amostraErros: metrica.erros,
    };

    const outPath = path.join(__dirname, "..", "docs", "resultado-simulacao-s11d-500.json");
    fs.writeFileSync(outPath, JSON.stringify(relatorio, null, 2));

    console.log(`\n${"=".repeat(70)}`);
    console.log(`RESUMO — ${duracaoTotalS}s, ${metrica.total} requisições (${metrica.ok} ok / ${metrica.falhas} falhas)`);
    console.log("=".repeat(70));
    console.log(JSON.stringify(relatorio.funil, null, 2));
    console.log(`\nRelatório completo salvo em: ${outPath}`);

  } finally {
    server.kill("SIGKILL");
  }
})().catch((e) => {
  console.error("Erro fatal na simulação:", e);
  process.exit(1);
});
