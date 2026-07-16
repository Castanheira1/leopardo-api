// Medição de km da viagem (GPS filtrado, Maps, tela) e SQL de viagem válida/período.
require("dotenv").config();
const { KM_MINIMO_VIAGEM, KM_SEGMENTO_MIN, KM_VELOCIDADE_MAX_H } = require("./config");
const { pool } = require("./db");
const { haversineKmCoord } = require("./geo");

function calcularKmGpsFromPontos(pontos) {
  if (!Array.isArray(pontos) || pontos.length < 2) {
    return { km: 0, valido: false, kmBruto: 0, segmentosValidos: 0, deslocamentoLinha: 0 };
  }
  let km = 0;
  let segmentosValidos = 0;
  for (let i = 1; i < pontos.length; i++) {
    const prev = pontos[i - 1];
    const cur = pontos[i];
    const seg = haversineKmCoord(prev.lat, prev.lng, cur.lat, cur.lng);
    const t0 = new Date(prev.registrado_em || prev.em || 0).getTime();
    const t1 = new Date(cur.registrado_em || cur.em || 0).getTime();
    const dtH = t1 > t0 ? (t1 - t0) / 3600000 : 0;
    if (dtH > 0 && seg / dtH > KM_VELOCIDADE_MAX_H) continue;
    if (seg < KM_SEGMENTO_MIN) continue;
    km += seg;
    segmentosValidos++;
  }
  const primeiro = pontos[0];
  const ultimo = pontos[pontos.length - 1];
  const deslocamentoLinha = haversineKmCoord(primeiro.lat, primeiro.lng, ultimo.lat, ultimo.lng);
  const kmArred = Math.round(km * 100) / 100;
  const valido = segmentosValidos >= 3
    && kmArred >= KM_MINIMO_VIAGEM
    && deslocamentoLinha >= KM_MINIMO_VIAGEM * 0.6;
  return {
    km: valido ? kmArred : 0,
    valido,
    kmBruto: kmArred,
    segmentosValidos,
    deslocamentoLinha: Math.round(deslocamentoLinha * 100) / 100,
  };
}

async function calcularKmGpsViagem(viagemId, opts = {}) {
  let sql = `SELECT lat::float8 AS lat, lng::float8 AS lng, registrado_em
     FROM viagem_pontos WHERE viagem_id = $1`;
  const params = [viagemId];
  if (opts.desde) {
    sql += ` AND registrado_em >= $2::timestamptz`;
    params.push(opts.desde);
  }
  sql += ` ORDER BY registrado_em`;
  const { rows } = await pool.query(sql, params);
  return calcularKmGpsFromPontos(rows);
}

function arredondarKm(km) {
  const n = Number(km);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100) / 100;
}

function parseKmMedicao(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0 || n > 2000) return 0;
  return n;
}

// Escolhe a melhor medição disponível (GPS pós-embarque, Maps ou km acumulado na tela).
function resolverKmMedicaoViagem(viagem, calcGps, kmMapsBody, kmTelaBody, opts = {}) {
  const noDestino = !!opts.noDestino;
  const maps = parseKmMedicao(kmMapsBody);
  const tela = parseKmMedicao(kmTelaBody);
  const candidatos = [];

  if (calcGps.kmBruto > 0) {
    candidatos.push({
      km: calcGps.valido ? calcGps.km : calcGps.kmBruto,
      valido: calcGps.valido,
      prio: 3,
      fonte: "gps",
    });
  }
  if (tela >= KM_MINIMO_VIAGEM) {
    candidatos.push({ km: tela, valido: true, prio: 2, fonte: "tela" });
  } else if (tela > 0) {
    candidatos.push({ km: tela, valido: false, prio: 1, fonte: "tela" });
  }
  // km do Maps é rota PLANEJADA (vem do app): só entra como medição se algo
  // independente confirmar o deslocamento — GPS/tela com movimento real ou o
  // carro reconhecido no destino. Finalizar parado não conta km.
  const mapsCorroborado = noDestino
    || calcGps.kmBruto >= KM_MINIMO_VIAGEM * 0.4
    || tela >= KM_MINIMO_VIAGEM * 0.4;
  if (mapsCorroborado && maps >= KM_MINIMO_VIAGEM) {
    candidatos.push({ km: maps, valido: true, prio: 2, fonte: "maps" });
  } else if (mapsCorroborado && maps > 0) {
    candidatos.push({ km: maps, valido: false, prio: 1, fonte: "maps" });
  }

  const valido = candidatos.filter((c) => c.valido).sort((a, b) => b.prio - a.prio)[0];
  if (valido) {
    return {
      km: arredondarKm(valido.km),
      valido: true,
      fonte: valido.fonte,
      km_maps: maps || null,
      km_tela: tela || null,
    };
  }

  const maior = [...candidatos].sort((a, b) => b.km - a.km)[0];
  if (maior && maior.km >= KM_MINIMO_VIAGEM * 0.4) {
    return {
      km: arredondarKm(maior.km),
      valido: maior.km >= KM_MINIMO_VIAGEM,
      fonte: maior.fonte,
      km_maps: maps || null,
      km_tela: tela || null,
    };
  }

  // Linha reta origem→destino: último recurso para GPS que falhou por completo,
  // e só quando o carro chegou de fato no destino (senão parado contaria km).
  if (noDestino && viagem?.embarque_em && viagem.destino_lat != null && viagem.origem_lat != null) {
    const linha = haversineKmCoord(
      +viagem.origem_lat, +viagem.origem_lng,
      +viagem.destino_lat, +viagem.destino_lng
    );
    if (linha >= KM_MINIMO_VIAGEM * 0.6) {
      return {
        km: arredondarKm(linha),
        valido: linha >= KM_MINIMO_VIAGEM,
        fonte: "linha",
        km_maps: maps || null,
        km_tela: tela || null,
      };
    }
  }

  return { km: 0, valido: false, fonte: null, km_maps: maps || null, km_tela: tela || null };
}

const sqlViagemKmValido = (alias = "v") => `${alias}.deslocamento_valido = TRUE`;

// Data da viagem no período: usa finalização; viagens antigas sem esse campo caem na data de início.
const sqlViagemNoPeriodo = (alias = "v") =>
  `COALESCE(${alias}.finalizada_em, ${alias}.iniciada_em) >= $2::timestamptz AND COALESCE(${alias}.finalizada_em, ${alias}.iniciada_em) < $3::timestamptz`;


module.exports = {
  calcularKmGpsFromPontos,
  calcularKmGpsViagem,
  arredondarKm,
  parseKmMedicao,
  resolverKmMedicaoViagem,
  sqlViagemKmValido,
  sqlViagemNoPeriodo,
};
