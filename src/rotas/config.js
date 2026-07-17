// Rotas públicas de configuração + /api/rotas (Routes API com cache e teto de custo).
require("dotenv").config();
const path = require("path");
const app = require("../app");
const { pool } = require("../db");
const { VAPID_PUBLIC } = require("../push");
const { verificarAuth } = require("../auth");

/* ============================ CONFIG ============================ */
app.get("/api/config", (req, res) => {
  res.json({
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "",
    mapsMapId: process.env.GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID",
    pushPublicKey: VAPID_PUBLIC,
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

// Rota pela pista (Routes API REST). Cache agressivo + teto de chamadas Google
// para não estourar fatura (frota fake + mapa do passageiro).
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
const ROTAS_GOOGLE_MAX_MIN = Number(process.env.ROTAS_GOOGLE_MAX_MIN || 30); // teto / minuto
const ROTAS_GOOGLE_MAX_DIA = Number(process.env.ROTAS_GOOGLE_MAX_DIA || 1500); // teto / dia (orçamento)
let rotasGoogleJanela = { t0: Date.now(), n: 0 };
let rotasGoogleDia = { dia: "", n: 0 };
const rotasGoogleStats = { hit: 0, miss: 0, google: 0, bloqueado: 0 };

function chaveRotaApprox(olat, olng, dlat, dlng) {
  // ~11 m de grade — carros da frota reutilizam a mesma rota
  const q = (n) => Number(n).toFixed(4);
  return `${q(olat)},${q(olng)}|${q(dlat)},${q(dlng)}`;
}

function rotasGooglePermitida() {
  // Teto DIÁRIO primeiro: é o freio de fatura de verdade — o teto por minuto
  // sozinho ainda deixaria passar dezenas de milhares de chamadas num dia.
  const hoje = new Date().toISOString().slice(0, 10);
  if (rotasGoogleDia.dia !== hoje) rotasGoogleDia = { dia: hoje, n: 0 };
  if (rotasGoogleDia.n >= ROTAS_GOOGLE_MAX_DIA) {
    rotasGoogleStats.bloqueado++;
    return false;
  }
  const agora = Date.now();
  if (agora - rotasGoogleJanela.t0 > 60_000) {
    rotasGoogleJanela = { t0: agora, n: 0 };
  }
  if (rotasGoogleJanela.n >= ROTAS_GOOGLE_MAX_MIN) {
    rotasGoogleStats.bloqueado++;
    return false;
  }
  rotasGoogleDia.n++;
  rotasGoogleJanela.n++;
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
  if (mem && agora - mem.em < ROTAS_CACHE_TTL_MS) {
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

  if (!rotasGooglePermitida()) {
    const payload = payloadFallbackReta();
    ROTAS_CACHE_MEM.set(chave, { ...payload, em: Date.now() });
    return res.json({
      ...payload,
      cached: false,
      aviso: "Limite de rotas Google; usando linha reta temporária.",
      stats: { ...rotasGoogleStats, teto_min: ROTAS_GOOGLE_MAX_MIN, teto_dia: ROTAS_GOOGLE_MAX_DIA, usadas_hoje: rotasGoogleDia.n },
    });
  }

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
      const payload = payloadFallbackReta();
      ROTAS_CACHE_MEM.set(chave, { ...payload, em: Date.now() });
      return res.json({ ...payload, cached: false, aviso: msg });
    }
    const route = j?.routes?.[0];
    const enc = route?.polyline?.encodedPolyline;
    if (!enc) {
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
    const payload = payloadFallbackReta();
    ROTAS_CACHE_MEM.set(chave, { ...payload, em: Date.now() });
    res.json({ ...payload, cached: false, aviso: e.message || "falha ao calcular rota" });
  }
});

// Diagnóstico de cota (admin / local)
app.get("/api/rotas/stats", verificarAuth, (req, res) => {
  res.json({
    ...rotasGoogleStats,
    teto_min: ROTAS_GOOGLE_MAX_MIN,
    cache_mem: ROTAS_CACHE_MEM.size,
    janela_n: rotasGoogleJanela.n,
  });
});


module.exports = {
  decodificarPolylineServer,
  ROTAS_CACHE_MEM,
  ROTAS_CACHE_TTL_MS,
  ROTAS_GOOGLE_MAX_MIN,
  ROTAS_GOOGLE_MAX_DIA,
  rotasGoogleJanela,
  rotasGoogleDia,
  rotasGoogleStats,
  chaveRotaApprox,
  rotasGooglePermitida,
  garantirTabelaRotasCache,
};
