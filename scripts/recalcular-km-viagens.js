#!/usr/bin/env node
/**
 * Recalcula distancia_km e deslocamento_valido de todas as viagens concluídas.
 * Uso: DATABASE_URL='...' node scripts/recalcular-km-viagens.js
 */
require("dotenv").config();
const { Pool } = require("pg");

const KM_MINIMO_VIAGEM = Number(process.env.KM_MINIMO_VIAGEM || 0.5);
const KM_SEGMENTO_MIN = Number(process.env.KM_SEGMENTO_MIN || 0.03);
const KM_VELOCIDADE_MAX_H = Number(process.env.KM_VELOCIDADE_MAX_H || 120);

function haversineKmCoord(lat1, lng1, lat2, lng2) {
  const p1 = Number(lat1);
  const p2 = Number(lat2);
  const g1 = Number(lng1);
  const g2 = Number(lng2);
  if (![p1, p2, g1, g2].every(Number.isFinite)) return 0;
  const dLat = ((p2 - p1) * Math.PI) / 180;
  const dLng = ((g2 - g1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((p1 * Math.PI) / 180) * Math.cos((p2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcularKmGpsFromPontos(pontos) {
  if (!Array.isArray(pontos) || pontos.length < 2) {
    return { km: 0, valido: false, kmBruto: 0 };
  }
  let km = 0;
  let segmentosValidos = 0;
  for (let i = 1; i < pontos.length; i++) {
    const prev = pontos[i - 1];
    const cur = pontos[i];
    const seg = haversineKmCoord(prev.lat, prev.lng, cur.lat, cur.lng);
    const t0 = new Date(prev.registrado_em).getTime();
    const t1 = new Date(cur.registrado_em).getTime();
    const dtH = t1 > t0 ? (t1 - t0) / 3600000 : 0;
    if (dtH > 0 && seg / dtH > KM_VELOCIDADE_MAX_H) continue;
    if (seg < KM_SEGMENTO_MIN) continue;
    km += seg;
    segmentosValidos++;
  }
  const deslocamentoLinha = haversineKmCoord(
    pontos[0].lat, pontos[0].lng,
    pontos[pontos.length - 1].lat, pontos[pontos.length - 1].lng
  );
  const kmArred = Math.round(km * 100) / 100;
  const valido = segmentosValidos >= 3
    && kmArred >= KM_MINIMO_VIAGEM
    && deslocamentoLinha >= KM_MINIMO_VIAGEM * 0.6;
  return { km: valido ? kmArred : 0, valido, kmBruto: kmArred };
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Defina DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({
  connectionString: url,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

(async () => {
  const client = await pool.connect();
  try {
    await client.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS deslocamento_valido BOOLEAN DEFAULT FALSE");
    await client.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS embarque_em TIMESTAMP");
    await client.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS km_maps NUMERIC(10,2)");
    await client.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS km_tela NUMERIC(10,2)");
    await client.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS km_fonte VARCHAR(20)");
    const { rows: viagens } = await client.query(
      "SELECT id, distancia_km, embarque_em, km_maps, km_tela, origem_lat, origem_lng, destino_lat, destino_lng FROM viagens WHERE status = 'concluida' ORDER BY id"
    );
    let validas = 0;
    for (const v of viagens) {
      let sql = "SELECT lat::float8 AS lat, lng::float8 AS lng, registrado_em FROM viagem_pontos WHERE viagem_id = $1";
      const params = [v.id];
      if (v.embarque_em) {
        sql += " AND registrado_em >= $2::timestamptz";
        params.push(v.embarque_em);
      }
      sql += " ORDER BY registrado_em";
      const { rows: pontos } = await client.query(sql, params);
      const calc = calcularKmGpsFromPontos(pontos);
      let km = calc.km;
      let valido = calc.valido;
      let fonte = calc.valido ? "gps" : null;
      const maps = Number(v.km_maps) || 0;
      const tela = Number(v.km_tela) || 0;
      if (!valido && tela >= KM_MINIMO_VIAGEM) { km = Math.round(tela * 100) / 100; valido = true; fonte = "tela"; }
      else if (!valido && maps >= KM_MINIMO_VIAGEM) { km = Math.round(maps * 100) / 100; valido = true; fonte = "maps"; }
      await client.query(
        "UPDATE viagens SET distancia_km = $2, deslocamento_valido = $3, km_fonte = COALESCE($4, km_fonte) WHERE id = $1",
        [v.id, km, valido, fonte]
      );
      if (calc.valido) validas++;
      console.log(`viagem ${v.id}: ${v.distancia_km} km → ${calc.km} km (bruto ${calc.kmBruto}) valido=${calc.valido}`);
    }
    console.log(`OK — ${validas}/${viagens.length} viagens com deslocamento GPS válido (>= ${KM_MINIMO_VIAGEM} km)`);
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error("Falha:", e.message);
  process.exit(1);
});
