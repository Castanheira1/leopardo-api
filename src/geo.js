// Geometria de rota em SQL e JS: haversine, corredor do segmento e compatibilidade de match.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { RAIO_MESMO_DEST_KM, RAIO_PROXIMO_KM, RAIO_ROTA_KM } = require("./config");
const { pool } = require("./db");

// Expressão Haversine (km) entre uma coluna (latCol/lngCol) e parâmetros $i/$j
const haversine = (latCol, lngCol, pLat, pLng) => `
  (6371 * acos(LEAST(1, GREATEST(-1,
    cos(radians(${pLat})) * cos(radians(${latCol})) * cos(radians(${lngCol}) - radians(${pLng}))
    + sin(radians(${pLat})) * sin(radians(${latCol}))
  ))))`;

// Distância (km) de um ponto até o SEGMENTO A→B (projeção equirretangular local).
function sqlSegmentoBase(latCol, lngCol, aLat, aLng, bLat, bLng) {
  const px = `((${lngCol}) - (${aLng})) * 111.320 * cos(radians(${aLat}))`;
  const py = `((${latCol}) - (${aLat})) * 110.574`;
  const bx = `((${bLng}) - (${aLng})) * 111.320 * cos(radians(${aLat}))`;
  const by = `((${bLat}) - (${aLat})) * 110.574`;
  const denom = `NULLIF((${bx})*(${bx}) + (${by})*(${by}), 0)`;
  return { px, py, bx, by, denom };
}

function sqlParametroSegmento(latCol, lngCol, aLat, aLng, bLat, bLng) {
  const { px, py, bx, by, denom } = sqlSegmentoBase(latCol, lngCol, aLat, aLng, bLat, bLng);
  return `COALESCE((( ${px} )*(${bx}) + ( ${py} )*(${by})) / ${denom}, 0)`;
}

function distanciaSegmentoKm(latCol, lngCol, aLat, aLng, bLat, bLng) {
  const { px, py, bx, by, denom } = sqlSegmentoBase(latCol, lngCol, aLat, aLng, bLat, bLng);
  const t = `LEAST(1, GREATEST(0, COALESCE((( ${px} )*(${bx}) + ( ${py} )*(${by})) / ${denom}, 0)))`;
  return `sqrt(POWER((${px}) - (${t})*(${bx}), 2) + POWER((${py}) - (${t})*(${by}), 2))`;
}

function sqlCorredorSegmento(latCol, lngCol, aLat, aLng, bLat, bLng, raioKm) {
  const { px, py, bx, by, denom } = sqlSegmentoBase(latCol, lngCol, aLat, aLng, bLat, bLng);
  const tRaw = sqlParametroSegmento(latCol, lngCol, aLat, aLng, bLat, bLng);
  const tClamp = `LEAST(1, GREATEST(0, ${tRaw}))`;
  const dist = `sqrt(POWER((${px}) - (${tClamp})*(${bx}), 2) + POWER((${py}) - (${tClamp})*(${by}), 2))`;
  return {
    t: tRaw,
    dist,
    noSegmento: `(${dist} <= ${raioKm} AND ${tRaw} >= 0 AND ${tRaw} <= 1)`,
    alemDestino: `(${dist} <= ${raioKm} AND ${tRaw} > 1)`,
  };
}

// Destino do passageiro no trajeto publicado: mesmo ponto OU entre origem e destino.
function sqlDestinoPassageiroNaCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const cor = sqlCorredorSegmento(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  const mesmo = `${haversine(carDestLat, carDestLng, pDestLat, pDestLng)} <= ${RAIO_MESMO_DEST_KM}`;
  return `(${mesmo} OR ${cor.noSegmento})`;
}

// Destino do passageiro além do fim da carona (mesma pista, motorista não vai até lá).
function sqlDestinoPassageiroAlemCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const cor = sqlCorredorSegmento(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  return cor.alemDestino;
}

// Compatibilidade total: embarque E desembarque dentro do segmento publicado.
function sqlPedidoCombinaComCarona(pOrigLat, pOrigLng, pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const destOk = sqlDestinoPassageiroNaCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng);
  const origCor = sqlCorredorSegmento(pOrigLat, pOrigLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  return `(${destOk} AND ${origCor.noSegmento})`;
}

// Parcial: passageiro quer ir além — só até o destino do motorista.
function sqlPedidoCombinaComCaronaParcial(pOrigLat, pOrigLng, pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const destParcial = sqlDestinoPassageiroAlemCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng);
  const origCor = sqlCorredorSegmento(pOrigLat, pOrigLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  return `(${destParcial} AND ${origCor.noSegmento})`;
}

// Próximo: destino do passageiro perto do destino da carona ou do corredor, mas não total/parcial.
function sqlDestinoProximoCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const total = sqlDestinoPassageiroNaCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng);
  const parcial = sqlDestinoPassageiroAlemCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng);
  const pertoDest = `${haversine(carDestLat, carDestLng, pDestLat, pDestLng)} <= ${RAIO_PROXIMO_KM}`;
  const corPax = sqlCorredorSegmento(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_PROXIMO_KM);
  const pertoCorredor = `(${corPax.dist} <= ${RAIO_PROXIMO_KM})`;
  return `(NOT (${total}) AND NOT (${parcial}) AND (${pertoDest} OR ${pertoCorredor}))`;
}

function sqlPedidoCombinaComCaronaProximo(pOrigLat, pOrigLng, pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const destProx = sqlDestinoProximoCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng);
  const origCor = sqlCorredorSegmento(pOrigLat, pOrigLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  return `(${destProx} AND ${origCor.noSegmento})`;
}

// Motorista "na pista": GPS na faixa da rota do passageiro OU carona publicada compatível.
function sqlMotoristaNaRotaPassageiro(pOrigLat, pOrigLng, pDestLat, pDestLng, gpsLatCol, gpsLngCol, motoristaIdCol) {
  const gpsNaFaixa = `${distanciaSegmentoKm(gpsLatCol, gpsLngCol, pOrigLat, pOrigLng, pDestLat, pDestLng)} <= ${RAIO_ROTA_KM}`;
  const caronaCompat = `EXISTS (
    SELECT 1 FROM caronas ca
    WHERE ca.motorista_id = ${motoristaIdCol}
      AND ca.status = 'ativa' AND ca.vagas > 0
      AND ca.origem_lat IS NOT NULL AND ca.destino_lat IS NOT NULL
      AND (
        ${sqlPedidoCombinaComCarona(pOrigLat, pOrigLng, pDestLat, pDestLng, "ca.origem_lat", "ca.origem_lng", "ca.destino_lat", "ca.destino_lng")}
        OR ${sqlPedidoCombinaComCaronaParcial(pOrigLat, pOrigLng, pDestLat, pDestLng, "ca.origem_lat", "ca.origem_lng", "ca.destino_lat", "ca.destino_lng")}
        OR ${sqlPedidoCombinaComCaronaProximo(pOrigLat, pOrigLng, pDestLat, pDestLng, "ca.origem_lat", "ca.origem_lng", "ca.destino_lat", "ca.destino_lng")}
      )
  )`;
  return `(${gpsNaFaixa} OR ${caronaCompat})`;
}

function corredorSegmentoKm(lat, lng, aLat, aLng, bLat, bLng) {
  const px = (lng - aLng) * 111.320 * Math.cos((aLat * Math.PI) / 180);
  const py = (lat - aLat) * 110.574;
  const bx = (bLng - aLng) * 111.320 * Math.cos((aLat * Math.PI) / 180);
  const by = (bLat - aLat) * 110.574;
  const denom = bx * bx + by * by;
  const tRaw = denom > 0 ? (px * bx + py * by) / denom : 0;
  const t = Math.min(1, Math.max(0, tRaw));
  const dist = Math.sqrt((px - t * bx) ** 2 + (py - t * by) ** 2);
  return { t: tRaw, dist };
}

function compatRotaPassageiro(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const dl = Number(pDestLat);
  const dg = Number(pDestLng);
  const oLat = Number(carOrigLat);
  const oLng = Number(carOrigLng);
  const dLat = Number(carDestLat);
  const dLng = Number(carDestLng);
  if (![dl, dg, oLat, oLng, dLat, dLng].every(Number.isFinite)) return "none";

  const mesmo = haversineKmCoord(dLat, dLng, dl, dg) <= RAIO_MESMO_DEST_KM;
  const cor = corredorSegmentoKm(dl, dg, oLat, oLng, dLat, dLng);
  if (mesmo || (cor.dist <= RAIO_ROTA_KM && cor.t >= 0 && cor.t <= 1)) return "total";
  if (cor.dist <= RAIO_ROTA_KM && cor.t > 1) return "parcial";

  const pertoDest = haversineKmCoord(dLat, dLng, dl, dg) <= RAIO_PROXIMO_KM;
  const pertoCor = cor.dist <= RAIO_PROXIMO_KM;
  if (pertoDest || pertoCor) return "proximo";
  return "none";
}

/* ==================== PONTO EM COMUM ("encaixe") ====================
 * A geometria de linha reta não enxerga que dois trajetos diferentes dividem
 * o mesmo tronco de estrada (todo mundo passa pela Portaria). O catálogo de
 * locais do projeto (locais-favoritos.json — mesmos pontos que o app mostra
 * no menu Locais) vira a malha de referência: se um local conhecido está no
 * corredor do MOTORISTA e deixa o PASSAGEIRO bem mais perto do destino dele,
 * é um encaixe — o motorista leva até ali e o passageiro segue do ponto.
 */

// Avanço mínimo (km) que o ponto em comum precisa dar ao passageiro para valer
// a pena (senão viraria "desce onde você já está").
const ENCAIXE_AVANCO_MIN_KM = Number(process.env.ENCAIXE_AVANCO_MIN_KM || 1);

// Catálogo em memória (recarrega se o arquivo mudar — deploy não exige restart).
let _catalogoLocais = { mtimeMs: 0, porCodigo: {} };
function locaisDoProjetoCodigo(codigo) {
  if (!codigo) return [];
  try {
    const arq = path.join(__dirname, "..", "public", "locais-favoritos.json");
    const st = fs.statSync(arq);
    if (st.mtimeMs !== _catalogoLocais.mtimeMs) {
      const bruto = JSON.parse(fs.readFileSync(arq, "utf8"));
      const porCodigo = {};
      Object.entries(bruto.projetos || {}).forEach(([cod, proj]) => {
        const flat = [];
        (proj.grupos || []).forEach((g) => (g.locais || []).forEach((l) => {
          if (l.ref && Number.isFinite(+l.ref.lat) && Number.isFinite(+l.ref.lng)) {
            flat.push({ nome: l.nome, lat: +l.ref.lat, lng: +l.ref.lng });
          }
        }));
        porCodigo[cod.toUpperCase()] = flat;
      });
      _catalogoLocais = { mtimeMs: st.mtimeMs, porCodigo };
    }
    return _catalogoLocais.porCodigo[String(codigo).toUpperCase()] || [];
  } catch (e) {
    console.warn("locaisDoProjetoCodigo:", e.message);
    return [];
  }
}

// projeto_id -> codigo ("S11D"), com cache simples (a tabela projetos é estática).
const _codigoProjetoCache = new Map();
async function codigoDoProjeto(projetoId) {
  if (!projetoId) return null;
  if (_codigoProjetoCache.has(projetoId)) return _codigoProjetoCache.get(projetoId);
  try {
    const { rows } = await pool.query("SELECT codigo FROM projetos WHERE id = $1", [projetoId]);
    const cod = rows[0]?.codigo || null;
    _codigoProjetoCache.set(projetoId, cod);
    return cod;
  } catch (_) { return null; }
}

// Melhor ponto em comum entre a rota do MOTORISTA (carOrig->carDest) e a viagem
// do PASSAGEIRO (origPax->destPax). Candidatos: SÓ locais NOMEADOS do catálogo —
// o encaixe é um ponto de transbordo conhecido (Portaria, rodoviária…), onde o
// passageiro desce e consegue outra carona; largar num destino qualquer no meio
// do nada não é encaixe (e o caso "um pouco além do fim" já é o compat parcial).
// Critérios: o ponto está no corredor do motorista (RAIO_ROTA_KM) e deixa o
// passageiro pelo menos ENCAIXE_AVANCO_MIN_KM mais perto do destino. Vence o
// que deixa MENOS caminho restante.
// Retorna { nome, lat, lng, restante_km, avanco_km } ou null.
function melhorPontoDeEncaixe(origPax, destPax, carOrig, carDest, locais) {
  const oLat = Number(origPax?.lat), oLng = Number(origPax?.lng);
  const dLat = Number(destPax?.lat), dLng = Number(destPax?.lng);
  const cOLat = Number(carOrig?.lat), cOLng = Number(carOrig?.lng);
  const cDLat = Number(carDest?.lat), cDLng = Number(carDest?.lng);
  if (![oLat, oLng, dLat, dLng, cOLat, cOLng, cDLat, cDLng].every(Number.isFinite)) return null;

  const totalPax = haversineKmCoord(oLat, oLng, dLat, dLng);
  if (!(totalPax > 0)) return null;

  const candidatos = (Array.isArray(locais) ? locais : []).filter((l) => l && l.nome);
  // Onde o passageiro EMBARCA na rota do motorista: pontos ANTES disso já ficaram
  // para trás — o carro não volta. (t clampado; se a origem está fora do corredor,
  // o embarque acontece perto do início e o clamp resolve.)
  const tEmbarque = Math.min(1, Math.max(0, corredorSegmentoKm(oLat, oLng, cOLat, cOLng, cDLat, cDLng).t));
  let melhor = null;
  for (const p of candidatos) {
    const lat = Number(p.lat), lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // Ponto precisa estar no corredor do motorista, À FRENTE do embarque (com
    // pequena folga no fim — parar junto ao destino dele ainda é caminho dele).
    const cor = corredorSegmentoKm(lat, lng, cOLat, cOLng, cDLat, cDLng);
    if (!(cor.dist <= RAIO_ROTA_KM && cor.t >= tEmbarque - 0.02 && cor.t <= 1.05)) continue;
    const restante = haversineKmCoord(lat, lng, dLat, dLng);
    const avanco = totalPax - restante;
    if (avanco < ENCAIXE_AVANCO_MIN_KM) continue;          // não adianta quase nada
    if (restante <= RAIO_MESMO_DEST_KM) continue;          // isso é compat total, não encaixe
    if (!melhor || restante < melhor.restante_km) {
      melhor = { nome: p.nome || null, lat, lng, restante_km: restante, avanco_km: avanco };
    }
  }
  return melhor;
}

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


module.exports = {
  haversine,
  sqlSegmentoBase,
  sqlParametroSegmento,
  distanciaSegmentoKm,
  sqlCorredorSegmento,
  sqlDestinoPassageiroNaCarona,
  sqlDestinoPassageiroAlemCarona,
  sqlPedidoCombinaComCarona,
  sqlPedidoCombinaComCaronaParcial,
  sqlDestinoProximoCarona,
  sqlPedidoCombinaComCaronaProximo,
  sqlMotoristaNaRotaPassageiro,
  corredorSegmentoKm,
  compatRotaPassageiro,
  ENCAIXE_AVANCO_MIN_KM,
  _catalogoLocais,
  locaisDoProjetoCodigo,
  _codigoProjetoCache,
  codigoDoProjeto,
  melhorPontoDeEncaixe,
  haversineKmCoord,
};
