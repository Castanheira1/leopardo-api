// Rotas públicas de configuração + /api/rotas (Routes API com cache e teto de custo).
require("dotenv").config();
const path = require("path");
const app = require("../app");
const { pool } = require("../db");
const { VAPID_PUBLIC } = require("../push");
const { verificarAuth } = require("../auth");

/* ============================ CONFIG ============================ */
app.get("/api/config", (req, res) => {
  // routesGoogle: front NÃO deve spamar /api/rotas quando false (linha reta local).
  const routesGoogle = /^(1|true|yes|on)$/i.test(String(process.env.GOOGLE_ROUTES_ENABLED || ""));
  res.json({
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "",
    mapsMapId: process.env.GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID",
    pushPublicKey: VAPID_PUBLIC,
    routesGoogle,
  });
});

// Health-check para monitor externo (UptimeRobot etc.): confirma DB de verdade.
// 200 com db:true = saudável; 503 = app de pé mas sem banco. O healthCheckPath
// do Render continua no /api/config (app de pé) para não reiniciar em falha de DB.
const INICIO_PROCESSO = Date.now();
const VERSAO_APP = require("../../package.json").version;
app.get("/api/health", async (req, res) => {
  let db = false;
  try { await pool.query("SELECT 1"); db = true; } catch (_) {}
  res.status(db ? 200 : 503).json({
    ok: db,
    db,
    versao: VERSAO_APP,
    uptime_s: Math.round((Date.now() - INICIO_PROCESSO) / 1000),
    agora: new Date().toISOString(),
  });
});

// Rota pela pista (Routes API REST). DESLIGADA por padrão — cada computeRoutes
// custa dinheiro (SKU "Routes: Compute Routes Essentials"). Só liga com
// GOOGLE_ROUTES_ENABLED=1 no Render/.env. Sem isso: linha reta + cache local.
function decodificarPolylineServer(str) {
  let idx = 0, lat = 0, lng = 0;
  const pts = [];
  while (idx < str.length) {
    for (const eixo of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(idx++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (eixo === 0) lat += d; else lng += d;
    }
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

const ROTAS_CACHE_MEM = new Map(); // chave -> { path, distanceMeters, durationMillis, km, em }
const ROTAS_CACHE_TTL_MS = Number(process.env.ROTAS_CACHE_TTL_MS || 6 * 60 * 60 * 1000); // 6 h
// Opt-in explícito. Default OFF = zero chamada paga a Routes (evita fatura surpresa).
const GOOGLE_ROUTES_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.GOOGLE_ROUTES_ENABLED || ""));
// Tetos espelham a cota do console Google (300/dia definida em 2026-07) — o
// código não deve ser MAIS restritivo que a cota paga que o dono aceitou.
// Contra loop/alucinação quem protege é: recálculo só por mudança de destino
// + throttle no cliente + teto por minuto. Para escalar: subir env + console.
// Valores PADRÃO (env). O dono pode sobrescrever pelo painel — ver limitesRotas().
const ROTAS_GOOGLE_MAX_MIN = Number(process.env.ROTAS_GOOGLE_MAX_MIN || 30);
const ROTAS_GOOGLE_MAX_DIA = Number(process.env.ROTAS_GOOGLE_MAX_DIA || 300);
// Teto MENSAL sob a cota grátis (Routes Essentials: 10.000/mês desde mar/2025).
// Persiste no Postgres — restart/deploy não zera o contador.
const ROTAS_GOOGLE_MAX_MES = Number(process.env.ROTAS_GOOGLE_MAX_MES || 9000);

/* Limites ajustáveis pelo painel do dono (tabela config_app), com o env como
   padrão. Lidos com cache curto para não fazer query a cada rota.
   TETO_SEGURANCA existe para que um zero a mais digitado por engano não vire
   fatura: nem o painel nem o env conseguem passar disso. */
const TETO_SEGURANCA = { min: 500, dia: 20000, mes: 300000 };
const LIMITES_CACHE_MS = 30_000;
let _limitesCache = null;
let _limitesEm = 0;

function clampLimite(v, padrao, teto) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return padrao;
  return Math.min(Math.round(n), teto);
}

async function garantirTabelaConfig() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_app (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,
      atualizado_em TIMESTAMP DEFAULT NOW(),
      atualizado_por TEXT
    )`).catch(() => {});
}

async function limitesRotas() {
  const agora = Date.now();
  if (_limitesCache && agora - _limitesEm < LIMITES_CACHE_MS) return _limitesCache;
  const base = {
    min: clampLimite(ROTAS_GOOGLE_MAX_MIN, 30, TETO_SEGURANCA.min),
    dia: clampLimite(ROTAS_GOOGLE_MAX_DIA, 300, TETO_SEGURANCA.dia),
    mes: clampLimite(ROTAS_GOOGLE_MAX_MES, 9000, TETO_SEGURANCA.mes),
    origem: "env",
  };
  try {
    await garantirTabelaConfig();
    const { rows } = await pool.query(
      "SELECT chave, valor FROM config_app WHERE chave LIKE 'rotas_max_%'"
    );
    for (const r of rows) {
      if (r.chave === "rotas_max_min") base.min = clampLimite(r.valor, base.min, TETO_SEGURANCA.min);
      if (r.chave === "rotas_max_dia") base.dia = clampLimite(r.valor, base.dia, TETO_SEGURANCA.dia);
      if (r.chave === "rotas_max_mes") base.mes = clampLimite(r.valor, base.mes, TETO_SEGURANCA.mes);
    }
    if (rows.length) base.origem = "painel";
  } catch (_) { /* sem DB: fica no env */ }
  _limitesCache = base;
  _limitesEm = agora;
  return base;
}

// Chamado pelo endpoint de gravação para o novo valor valer na hora.
function invalidarCacheLimites() { _limitesEm = 0; }
let rotasGoogleJanela = { t0: Date.now(), n: 0 };
let rotasGoogleDia = { dia: "", n: 0 };
const rotasGoogleStats = {
  hit: 0, miss: 0, google: 0, bloqueado: 0, erro: 0, pausas: 0,
  enabled: GOOGLE_ROUTES_ENABLED,
};
if (GOOGLE_ROUTES_ENABLED) {
  console.warn(
    `[rotas] Google Routes LIGADO (max ${ROTAS_GOOGLE_MAX_MIN}/min, ${ROTAS_GOOGLE_MAX_DIA}/dia) — gera cobrança`
  );
} else {
  console.log("[rotas] Google Routes DESLIGADO — /api/rotas usa linha reta (sem fatura Routes)");
}

function chaveRotaApprox(olat, olng, dlat, dlng) {
  // ~11 m de grade — carros da frota reutilizam a mesma rota
  const q = (n) => Number(n).toFixed(4);
  return `${q(olat)},${q(olng)}|${q(dlat)},${q(dlng)}`;
}

// Contador de uso persistido: restart/deploy do Render NÃO zera o teto
// (contador só em memória deixava crash-loop furar o limite diário).
async function garantirTabelaRotasUso() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotas_uso (
      dia TEXT PRIMARY KEY,
      n INTEGER NOT NULL DEFAULT 0
    )`).catch(() => {});
  // Janela por MINUTO também no banco: com mais de uma instância (autoscaling
  // do Render), um contador em memória por processo faria o teto virar
  // N × ROTAS_GOOGLE_MAX_MIN — justo quando há mais tráfego para descontrolar.
  // Chave = 'AAAA-MM-DDTHH:MM' (UTC).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotas_uso_min (
      minuto TEXT PRIMARY KEY,
      n INTEGER NOT NULL DEFAULT 0
    )`).catch(() => {});
}

function chaveMinutoUtc(d = new Date()) {
  return d.toISOString().slice(0, 16); // AAAA-MM-DDTHH:MM
}

// Devolve a cota quando a chamada não produziu rota (erro do Google, timeout).
// Sem isso, com a API negando (billing desligado, chave restrita) o contador
// subia a cada tentativa e o teto do dia se esgotava sem nenhuma rota real.
async function devolverCotaRota() {
  const hoje = new Date().toISOString().slice(0, 10);
  if (rotasGoogleDia.dia === hoje && rotasGoogleDia.n > 0) rotasGoogleDia.n--;
  if (rotasGoogleJanela.n > 0) rotasGoogleJanela.n--;
  await pool.query(
    "UPDATE rotas_uso SET n = GREATEST(n - 1, 0) WHERE dia = $1",
    [hoje]
  ).catch(() => {});
  await pool.query(
    "UPDATE rotas_uso_min SET n = GREATEST(n - 1, 0) WHERE minuto = $1",
    [chaveMinutoUtc()]
  ).catch(() => {});
}

// rotas_uso_min cresce 1 linha por minuto ativo. Limpa o que já passou —
// a janela só olha o minuto corrente, então histórico ali não serve para nada.
let _limpezaMinUltima = 0;
async function limparJanelasAntigas() {
  const agora = Date.now();
  if (agora - _limpezaMinUltima < 60 * 60 * 1000) return; // no máximo 1x/hora
  _limpezaMinUltima = agora;
  const corte = new Date(agora - 10 * 60 * 1000).toISOString().slice(0, 16);
  await pool.query("DELETE FROM rotas_uso_min WHERE minuto < $1", [corte]).catch(() => {});
}

/* Disjuntor: erro PERMANENTE (billing desligado, API não habilitada, chave sem
   permissão) não melhora se repetir. Em vez de chamar o Google a cada rota e
   sempre cair na reta, para de tentar por um tempo e serve reta direto —
   zero chamada e zero risco de cobrança enquanto o problema não é resolvido. */
const ROTAS_PAUSA_MS = Number(process.env.ROTAS_PAUSA_ERRO_MS || 30 * 60 * 1000); // 30 min
let rotasPausadoAte = 0;
let rotasPausaMotivo = "";

// Mensagens reais do Google que NÃO melhoram se repetir:
//   400 "API key not valid. Please pass a valid API key."     (chave errada)
//   403 "...Routes API has not been used in project..."       (API não habilitada)
//   403 PERMISSION_DENIED / billing                           (faturamento off)
//   403 "requests from this ... are blocked"                  (restrição da chave)
function ehErroPermanenteRotas(status, msg) {
  const t = String(msg || "");
  return status === 401 || status === 403
    || /billing|PERMISSION_DENIED|API[ _-]?key|not authorized|has not been used|is disabled|are blocked|REQUEST_DENIED/i.test(t);
}

function pausarRotas(motivo) {
  rotasPausadoAte = Date.now() + ROTAS_PAUSA_MS;
  rotasPausaMotivo = String(motivo || "erro permanente").slice(0, 200);
  rotasGoogleStats.pausas++;
  console.warn(
    `[rotas] Google Routes PAUSADO por ${Math.round(ROTAS_PAUSA_MS / 60000)} min — ${rotasPausaMotivo}. ` +
    "Servindo linha reta sem chamar a API."
  );
}

async function rotasGooglePermitida() {
  if (!GOOGLE_ROUTES_ENABLED) {
    rotasGoogleStats.bloqueado++;
    return false;
  }
  if (Date.now() < rotasPausadoAte) {
    rotasGoogleStats.bloqueado++;
    return false;
  }
  // Limites vigentes: painel do dono (config_app) ou env como padrão.
  const LIM = await limitesRotas();
  const hoje = new Date().toISOString().slice(0, 10);
  if (rotasGoogleDia.dia !== hoje) rotasGoogleDia = { dia: hoje, n: 0 };
  const agora = Date.now();
  if (agora - rotasGoogleJanela.t0 > 60_000) {
    rotasGoogleJanela = { t0: agora, n: 0 };
  }

  // Checa mês ANTES de incrementar o dia — evita spam pós-teto “envenenar”
  // o contador mensal e bloquear Routes para todo mundo o resto do mês.
  try {
    await garantirTabelaRotasUso();
    const mesQ = await pool.query(
      "SELECT COALESCE(SUM(n), 0) AS total FROM rotas_uso WHERE dia LIKE $1",
      [hoje.slice(0, 7) + "%"]
    );
    if (Number(mesQ.rows[0]?.total || 0) >= LIM.mes) {
      rotasGoogleStats.bloqueado++;
      return false;
    }
    const diaQ = await pool.query(
      "SELECT COALESCE(n, 0) AS n FROM rotas_uso WHERE dia = $1",
      [hoje]
    );
    rotasGoogleDia.n = Number(diaQ.rows[0]?.n || 0);
    if (rotasGoogleDia.n >= LIM.dia) {
      rotasGoogleStats.bloqueado++;
      return false;
    }
  } catch (_) {
    if (rotasGoogleDia.n >= LIM.dia) {
      rotasGoogleStats.bloqueado++;
      return false;
    }
  }

  // Burst por minuto: incrementa só se ainda abaixo do teto (WHERE n < lim).
  try {
    await garantirTabelaRotasUso();
    const q = await pool.query(
      `INSERT INTO rotas_uso_min (minuto, n) VALUES ($1, 1)
       ON CONFLICT (minuto) DO UPDATE SET n = rotas_uso_min.n + 1
       WHERE rotas_uso_min.n < $2
       RETURNING n`,
      [chaveMinutoUtc(), LIM.min]
    );
    limparJanelasAntigas().catch(() => {});
    if (!q.rows.length) {
      rotasGoogleStats.bloqueado++;
      return false;
    }
    rotasGoogleJanela.n = Number(q.rows[0].n || 0);
  } catch (_) {
    if (rotasGoogleJanela.n >= LIM.min) {
      rotasGoogleStats.bloqueado++;
      return false;
    }
    rotasGoogleJanela.n++;
  }

  // Dia: incrementa só se ainda abaixo do teto.
  try {
    const inc = await pool.query(
      `INSERT INTO rotas_uso (dia, n) VALUES ($1, 1)
       ON CONFLICT (dia) DO UPDATE SET n = rotas_uso.n + 1
       WHERE rotas_uso.n < $2
       RETURNING n`,
      [hoje, LIM.dia]
    );
    if (!inc.rows.length) {
      rotasGoogleStats.bloqueado++;
      return false;
    }
    rotasGoogleDia.n = Number(inc.rows[0].n || 0);
  } catch (_) {
    if (rotasGoogleDia.n >= LIM.dia) {
      rotasGoogleStats.bloqueado++;
      return false;
    }
    rotasGoogleDia.n++;
  }
  return true;
}

// Teto POR USUÁRIO (JWT): impede um token sozinho queimar a cota global.
// Em memória (1 instância Render starter). Env: ROTAS_USER_MAX_MIN / ROTAS_USER_MAX_DIA.
const ROTAS_USER_MAX_MIN = Number(process.env.ROTAS_USER_MAX_MIN || 5);
const ROTAS_USER_MAX_DIA = Number(process.env.ROTAS_USER_MAX_DIA || 40);
const _userRotasUso = new Map(); // `${uid}:${dia}` → { n, minT0, minN }

function _estadoRotasUsuario(userId) {
  if (!userId) return null;
  const hoje = new Date().toISOString().slice(0, 10);
  const key = `${userId}:${hoje}`;
  let s = _userRotasUso.get(key);
  if (!s) {
    s = { n: 0, minT0: Date.now(), minN: 0 };
    _userRotasUso.set(key, s);
    if (_userRotasUso.size > 5000) {
      for (const k of _userRotasUso.keys()) {
        if (!k.endsWith(`:${hoje}`)) _userRotasUso.delete(k);
      }
    }
  }
  const agora = Date.now();
  if (agora - s.minT0 > 60_000) {
    s.minT0 = agora;
    s.minN = 0;
  }
  return s;
}

function rotasUsuarioCabe(userId) {
  if (!userId) return true;
  const s = _estadoRotasUsuario(userId);
  return s.minN < ROTAS_USER_MAX_MIN && s.n < ROTAS_USER_MAX_DIA;
}

function rotasUsuarioConsumir(userId) {
  if (!userId) return;
  const s = _estadoRotasUsuario(userId);
  if (!s) return;
  s.minN++;
  s.n++;
}

function rotasUsuarioPermitida(userId) {
  if (!rotasUsuarioCabe(userId)) {
    rotasGoogleStats.bloqueado++;
    return false;
  }
  rotasUsuarioConsumir(userId);
  return true;
}

async function garantirTabelaRotasCache() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sim_rotas (
      chave TEXT PRIMARY KEY,
      pontos JSONB NOT NULL,
      criado_em TIMESTAMP DEFAULT NOW()
    )`).catch(() => {});
}

app.post("/api/rotas", verificarAuth, async (req, res) => {
  const olat = Number(req.body?.origin_lat ?? req.body?.origem_lat);
  const olng = Number(req.body?.origin_lng ?? req.body?.origem_lng);
  const dlat = Number(req.body?.dest_lat ?? req.body?.destino_lat);
  const dlng = Number(req.body?.dest_lng ?? req.body?.destino_lng);
  if (![olat, olng, dlat, dlng].every(Number.isFinite)) {
    return res.status(400).json({ error: "origin/dest lat,lng obrigatórios" });
  }
  const key = process.env.GOOGLE_MAPS_API_KEY || "";
  if (!key) return res.status(503).json({ error: "GOOGLE_MAPS_API_KEY ausente" });

  const chave = chaveRotaApprox(olat, olng, dlat, dlng);
  const agora = Date.now();
  const mem = ROTAS_CACHE_MEM.get(chave);
  // Fallback de cota: TTL curto (45s) — não “prende” OD em reta por 6h.
  const ttlMem = mem?.fallbackQuota ? 45_000 : ROTAS_CACHE_TTL_MS;
  if (mem && agora - mem.em < ttlMem) {
    rotasGoogleStats.hit++;
    return res.json({ ...mem, cached: true });
  }

  try {
    await garantirTabelaRotasCache();
    const hit = await pool.query("SELECT pontos FROM sim_rotas WHERE chave = $1", [chave]);
    if (hit.rows[0]?.pontos?.length >= 2) {
      const path = hit.rows[0].pontos;
      // distância aproximada se só temos polyline antiga
      let distanceMeters = 0;
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        const dLat = ((b.lat - a.lat) * Math.PI) / 180;
        const dLng = ((b.lng - a.lng) * Math.PI) / 180;
        const s = Math.sin(dLat / 2) ** 2
          + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        distanceMeters += 6371000 * 2 * Math.asin(Math.sqrt(s));
      }
      const payload = {
        path,
        distanceMeters: Math.round(distanceMeters),
        durationMillis: Math.round((distanceMeters / 1000 / 50) * 3600 * 1000),
        km: Math.round((distanceMeters / 1000) * 100) / 100,
      };
      ROTAS_CACHE_MEM.set(chave, { ...payload, em: agora });
      rotasGoogleStats.hit++;
      return res.json({ ...payload, cached: true });
    }
  } catch (_) { /* cache DB opcional */ }

  // Fallback em linha reta quando Google falha/estoura cota — evita 502 no app
  // (passageiro ainda vê o trajeto aproximado; frota usa sim_rotas quando possível).
  function payloadFallbackReta() {
    const R = 6371000;
    const dLat = ((dlat - olat) * Math.PI) / 180;
    const dLng = ((dlng - olng) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos((olat * Math.PI) / 180) * Math.cos((dlat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    const distanceMeters = Math.round(2 * R * Math.asin(Math.sqrt(a)));
    const durationMillis = Math.round((distanceMeters / 1000 / 35) * 3600 * 1000);
    const path = [
      { lat: olat, lng: olng },
      { lat: dlat, lng: dlng },
    ];
    return {
      path,
      distanceMeters,
      durationMillis,
      km: Math.round((distanceMeters / 1000) * 100) / 100,
      fallback: true,
    };
  }

  // Por usuário primeiro (barato, sem consumir) — depois cota global; só então conta o usuário.
  if (!rotasUsuarioCabe(req.user?.id)) {
    rotasGoogleStats.bloqueado++;
    const payload = payloadFallbackReta();
    ROTAS_CACHE_MEM.set(chave, { ...payload, em: Date.now(), fallbackQuota: true });
    return res.json({
      ...payload,
      cached: false,
      aviso: "Limite de rotas deste usuário; usando linha reta.",
    });
  }

  if (!(await rotasGooglePermitida())) {
    const payload = payloadFallbackReta();
    // Cache curto — não grava sim_rotas; libera Google assim que a cota voltar.
    ROTAS_CACHE_MEM.set(chave, { ...payload, em: Date.now(), fallbackQuota: true });
    let motivo;
    if (!GOOGLE_ROUTES_ENABLED) {
      motivo = "Routes Google desligado (GOOGLE_ROUTES_ENABLED). Linha reta — sem cobrança.";
    } else if (Date.now() < rotasPausadoAte) {
      // Diagnóstico honesto: não é teto de cota, é o Google recusando.
      motivo = `Routes pausada após erro do Google (${rotasPausaMotivo}). Linha reta, sem novas chamadas.`;
    } else {
      motivo = "Limite de rotas Google; usando linha reta.";
    }
    const LIM = await limitesRotas();
    return res.json({
      ...payload,
      cached: false,
      aviso: motivo,
      stats: {
        ...rotasGoogleStats,
        enabled: GOOGLE_ROUTES_ENABLED,
        teto_min: LIM.min,
        teto_dia: LIM.dia,
        usadas_hoje: rotasGoogleDia.n,
      },
    });
  }

  rotasUsuarioConsumir(req.user?.id);

  try {
    rotasGoogleStats.miss++;
    rotasGoogleStats.google++;
    const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: olat, longitude: olng } } },
        destination: { location: { latLng: { latitude: dlat, longitude: dlng } } },
        travelMode: "DRIVE",
      }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = j?.error?.message || `Routes HTTP ${r.status}`;
      console.warn("POST /api/rotas:", msg);
      rotasGoogleStats.erro++;
      // Não gastou cota de verdade: devolve o crédito e, se o erro for
      // permanente, para de tentar até alguém arrumar no Google Cloud.
      await devolverCotaRota();
      if (ehErroPermanenteRotas(r.status, msg)) pausarRotas(msg);
      const payload = payloadFallbackReta();
      ROTAS_CACHE_MEM.set(chave, { ...payload, em: Date.now() });
      return res.json({ ...payload, cached: false, aviso: msg });
    }
    const route = j?.routes?.[0];
    const enc = route?.polyline?.encodedPolyline;
    if (!enc) {
      rotasGoogleStats.erro++;
      await devolverCotaRota();
      const payload = payloadFallbackReta();
      ROTAS_CACHE_MEM.set(chave, { ...payload, em: Date.now() });
      return res.json({ ...payload, cached: false, aviso: "sem polyline na resposta" });
    }
    const path = decodificarPolylineServer(enc);
    const distanceMeters = Number(route.distanceMeters) || 0;
    let durationMillis = 0;
    const dur = route.duration;
    if (typeof dur === "string" && dur.endsWith("s")) {
      durationMillis = Math.round(parseFloat(dur) * 1000);
    } else if (dur?.seconds != null) {
      durationMillis = Math.round(Number(dur.seconds) * 1000);
    }
    const payload = {
      path,
      distanceMeters,
      durationMillis,
      km: Math.round((distanceMeters / 1000) * 100) / 100,
    };
    ROTAS_CACHE_MEM.set(chave, { ...payload, em: Date.now() });
    if (ROTAS_CACHE_MEM.size > 5000) {
      const first = ROTAS_CACHE_MEM.keys().next().value;
      ROTAS_CACHE_MEM.delete(first);
    }
    pool.query(
      `INSERT INTO sim_rotas (chave, pontos) VALUES ($1, $2)
       ON CONFLICT (chave) DO UPDATE SET pontos = EXCLUDED.pontos, criado_em = NOW()`,
      [chave, JSON.stringify(path)]
    ).catch(() => {});
    res.json({ ...payload, cached: false });
  } catch (e) {
    console.warn("POST /api/rotas:", e.message);
    rotasGoogleStats.erro++;
    await devolverCotaRota();
    const payload = payloadFallbackReta();
    ROTAS_CACHE_MEM.set(chave, { ...payload, em: Date.now() });
    res.json({ ...payload, cached: false, aviso: e.message || "falha ao calcular rota" });
  }
});

// Diagnóstico de cota (admin / local)
app.get("/api/rotas/stats", verificarAuth, async (req, res) => {
  let usadas_hoje = rotasGoogleDia.n;
  let usadas_mes = null;
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const q = await pool.query(
      `SELECT COALESCE(SUM(n) FILTER (WHERE dia = $1), 0) AS dia_n,
              COALESCE(SUM(n), 0) AS mes_n
         FROM rotas_uso WHERE dia LIKE $2`,
      [hoje, hoje.slice(0, 7) + "%"]
    );
    usadas_hoje = Number(q.rows[0]?.dia_n || 0);
    usadas_mes = Number(q.rows[0]?.mes_n || 0);
  } catch (_) { /* sem DB: fica o contador em memória */ }
  const LIM = await limitesRotas();
  res.json({
    ...rotasGoogleStats,
    enabled: GOOGLE_ROUTES_ENABLED,
    teto_min: LIM.min,
    teto_dia: LIM.dia,
    teto_mes: LIM.mes,
    limites_origem: LIM.origem,
    usadas_hoje,
    usadas_mes,
    cache_mem: ROTAS_CACHE_MEM.size,
    janela_n: rotasGoogleJanela.n,
    // Disjuntor: quando ligado, o app serve reta SEM chamar o Google.
    pausado: Date.now() < rotasPausadoAte,
    pausado_ate: rotasPausadoAte ? new Date(rotasPausadoAte).toISOString() : null,
    pausa_motivo: rotasPausaMotivo || null,
  });
});


module.exports = {
  decodificarPolylineServer,
  ROTAS_CACHE_MEM,
  ROTAS_CACHE_TTL_MS,
  ROTAS_GOOGLE_MAX_MIN,
  ROTAS_GOOGLE_MAX_DIA,
  ROTAS_GOOGLE_MAX_MES,
  rotasGoogleJanela,
  rotasGoogleDia,
  rotasGoogleStats,
  chaveRotaApprox,
  rotasGooglePermitida,
  rotasUsuarioCabe,
  rotasUsuarioConsumir,
  ROTAS_USER_MAX_MIN,
  ROTAS_USER_MAX_DIA,
  garantirTabelaRotasCache,
  // Tetos ajustáveis pelo painel do dono (config_app).
  limitesRotas,
  invalidarCacheLimites,
  garantirTabelaConfig,
  TETO_SEGURANCA,
  // Estado do disjuntor para o painel do dono (API Maps).
  estadoRotasGoogle: () => ({
    pausado: Date.now() < rotasPausadoAte,
    pausado_ate: rotasPausadoAte ? new Date(rotasPausadoAte).toISOString() : null,
    motivo: rotasPausaMotivo || null,
    erros: rotasGoogleStats.erro,
    pausas: rotasGoogleStats.pausas,
  }),
};
