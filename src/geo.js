// Geometria de rota em SQL e JS: haversine, corredor do segmento/polilinha e match.
// A reta origem→destino NÃO é a pista da mina: expandimos a carona pelos locais
// do catálogo que estão "no caminho" (desvio limitado) e medimos o corredor
// nessa polilinha — assim CMD no acostamento de MRO→Canteiro 07 casa como total.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { RAIO_MESMO_DEST_KM, RAIO_PROXIMO_KM, RAIO_ROTA_KM, ROTA_DESVIO_MAX_KM } = require("./config");
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

/**
 * Desvio (km) de ir O→P→D em relação a O→D.
 * 0 = P está exatamente no caminho geodésico; grande = P é desvio forte.
 */
function desvioCaminhoKm(oLat, oLng, pLat, pLng, dLat, dLng) {
  const base = haversineKmCoord(oLat, oLng, dLat, dLng);
  const d1 = haversineKmCoord(oLat, oLng, pLat, pLng);
  const d2 = haversineKmCoord(pLat, pLng, dLat, dLng);
  if (!(base > 0.01)) return d1;
  return d1 + d2 - base;
}

/**
 * P está no caminho da carona O→D?
 * Critério: O→P→D não alonga mais que ROTA_DESVIO_MAX_KM (sem inventar
 * polilinha com buffer — evita puxar CCP pra rota Portaria→Centro).
 */
function pontoNoCaminho(oLat, oLng, pLat, pLng, dLat, dLng, desvioMax) {
  const oLa = Number(oLat), oLn = Number(oLng);
  const pLa = Number(pLat), pLn = Number(pLng);
  const dLa = Number(dLat), dLn = Number(dLng);
  if (![oLa, oLn, pLa, pLn, dLa, dLn].every(Number.isFinite)) return false;
  const max = Number.isFinite(desvioMax) ? desvioMax
    : (Number.isFinite(ROTA_DESVIO_MAX_KM) ? ROTA_DESVIO_MAX_KM : 2.5);
  const base = haversineKmCoord(oLa, oLn, dLa, dLn);
  const d1 = haversineKmCoord(oLa, oLn, pLa, pLn);
  const d2 = haversineKmCoord(pLa, pLn, dLa, dLn);
  if (!(base > 0.01)) return d1 <= RAIO_ROTA_KM;
  if (d1 + d2 > base + max) return false;
  // Não conta ponto "atrás" da origem nem muito além do destino da carona.
  if (d1 > base + max * 0.35) return false;
  return true;
}

/**
 * Locais do catálogo que estão no caminho O→D (combinações válidas na carona).
 * Ordenados por distância à origem (progresso na viagem).
 */
function pontosNoCaminhoCarona(carOrigLat, carOrigLng, carDestLat, carDestLng, locais) {
  const oLat = Number(carOrigLat), oLng = Number(carOrigLng);
  const dLat = Number(carDestLat), dLng = Number(carDestLng);
  if (![oLat, oLng, dLat, dLng].every(Number.isFinite)) return [];
  const out = [];
  for (const p of Array.isArray(locais) ? locais : []) {
    const lat = Number(p.lat), lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!pontoNoCaminho(oLat, oLng, lat, lng, dLat, dLng)) continue;
    out.push({
      lat, lng, nome: p.nome || null,
      dOrig: haversineKmCoord(oLat, oLng, lat, lng),
      desvio: desvioCaminhoKm(oLat, oLng, lat, lng, dLat, dLng),
    });
  }
  out.sort((a, b) => a.dOrig - b.dOrig || a.desvio - b.desvio);
  return out;
}

/**
 * Expande O→D como lista de pontos no caminho (catálogo) + extremos.
 * Só para inspeção/debug — o match usa pontoNoCaminho, não buffer de polilinha.
 */
function expandirRotaPista(carOrigLat, carOrigLng, carDestLat, carDestLng, locais) {
  const oLat = Number(carOrigLat), oLng = Number(carOrigLng);
  const dLat = Number(carDestLat), dLng = Number(carDestLng);
  if (![oLat, oLng, dLat, dLng].every(Number.isFinite)) return [];
  const inicio = { lat: oLat, lng: oLng, nome: null };
  const fim = { lat: dLat, lng: dLng, nome: null };
  const vias = pontosNoCaminhoCarona(oLat, oLng, dLat, dLng, locais)
    .filter((p) => p.dOrig >= 0.08 && haversineKmCoord(p.lat, p.lng, dLat, dLng) >= 0.08);
  return [inicio, ...vias.map(({ lat, lng, nome }) => ({ lat, lng, nome })), fim];
}

/** Legado: distância a polilinha (mantido se algum caller ainda montar pts). */
function corredorPolilinhaKm(lat, lng, pts) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || !Array.isArray(pts) || pts.length < 2) {
    return { t: 0, dist: Infinity };
  }
  let total = 0;
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = haversineKmCoord(a.lat, a.lng, b.lat, b.lng);
    segs.push({ a, b, len: len > 1e-9 ? len : 1e-9 });
    total += len > 1e-9 ? len : 0;
  }
  if (!(total > 0)) {
    return { t: 0, dist: haversineKmCoord(la, ln, pts[0].lat, pts[0].lng) };
  }
  let bestDist = Infinity, bestT = 0, bestAlem = false, acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const { a, b, len } = segs[i];
    const cor = corredorSegmentoKm(la, ln, a.lat, a.lng, b.lat, b.lng);
    const tClamp = Math.min(1, Math.max(0, cor.t));
    const dist = cor.dist;
    const tGlobal = (acc + tClamp * len) / total;
    const alem = i === segs.length - 1 && cor.t > 1;
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) < 1e-9 && alem)) {
      bestDist = dist;
      bestT = alem ? Math.max(1.0001, (acc + len) / total + (cor.t - 1) * (len / total)) : tGlobal;
      bestAlem = alem;
    }
    acc += len;
  }
  if (bestAlem && bestT <= 1) bestT = 1.0001;
  return { t: bestT, dist: bestDist };
}

/**
 * Posição de um ponto em relação à carona O→D.
 * Preferência: "no caminho" (desvio) → dist=0, t=progresso O→D.
 * Senão: reta geométrica (parcial/próximo clássicos).
 */
function corredorRotaCaronaKm(lat, lng, carOrigLat, carOrigLng, carDestLat, carDestLng, _locais) {
  const la = Number(lat), ln = Number(lng);
  const oLat = Number(carOrigLat), oLng = Number(carOrigLng);
  const dLat = Number(carDestLat), dLng = Number(carDestLng);
  if (![la, ln, oLat, oLng, dLat, dLng].every(Number.isFinite)) {
    return { t: 0, dist: Infinity };
  }
  const base = haversineKmCoord(oLat, oLng, dLat, dLng);
  const dOrig = haversineKmCoord(oLat, oLng, la, ln);
  if (pontoNoCaminho(oLat, oLng, la, ln, dLat, dLng)) {
    const t = base > 0.01 ? Math.min(1, Math.max(0, dOrig / base)) : 0;
    return { t, dist: 0 };
  }
  // Além do destino na mesma direção: O→D→P com D no caminho O→P.
  if (base > 0.01 && pontoNoCaminho(oLat, oLng, dLat, dLng, la, ln)) {
    const dDest = haversineKmCoord(dLat, dLng, la, ln);
    return { t: 1 + dDest / base, dist: 0 };
  }
  return corredorSegmentoKm(la, ln, oLat, oLng, dLat, dLng);
}

/**
 * Compatibilidade do DESTINO do passageiro com a rota do motorista.
 * total  = destino do pax no caminho O→D da carona
 * parcial = motorista para antes: D da carona está no caminho O→destino_pax
 * @param {Array|null} [_locais] reservado (API estável); match usa geometria de caminho
 */
function compatRotaPassageiro(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng, _locais) {
  const dl = Number(pDestLat);
  const dg = Number(pDestLng);
  const oLat = Number(carOrigLat);
  const oLng = Number(carOrigLng);
  const dLat = Number(carDestLat);
  const dLng = Number(carDestLng);
  if (![dl, dg, oLat, oLng, dLat, dLng].every(Number.isFinite)) return "none";

  const mesmo = haversineKmCoord(dLat, dLng, dl, dg) <= RAIO_MESMO_DEST_KM;
  if (mesmo) return "total";

  // Destino do passageiro está no caminho da carona (ex.: CMD entre MRO e C07).
  if (pontoNoCaminho(oLat, oLng, dl, dg, dLat, dLng)) return "total";

  // Motorista só vai até o meio: o destino DELE está no caminho até o do pax
  // (ex.: Portaria→Centro enquanto pax vai Portaria→CMD).
  if (pontoNoCaminho(oLat, oLng, dLat, dLng, dl, dg)
    && haversineKmCoord(dLat, dLng, dl, dg) > RAIO_MESMO_DEST_KM) {
    return "parcial";
  }

  const cor = corredorSegmentoKm(dl, dg, oLat, oLng, dLat, dLng);
  if (cor.dist <= RAIO_ROTA_KM && cor.t >= 0 && cor.t <= 1) return "total";
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

// Melhor ponto em comum: local do catálogo que está NO CAMINHO da carona
// (desvio O→P→D pequeno) e adianta o passageiro. NÃO usa buffer de polilinha
// (isso puxava CCP para Portaria→Centro). Vence o que deixa MENOS restante.
// Retorna { nome, lat, lng, restante_km, avanco_km } ou null.
function melhorPontoDeEncaixe(origPax, destPax, carOrig, carDest, locais) {
  const oLat = Number(origPax?.lat), oLng = Number(origPax?.lng);
  const dLat = Number(destPax?.lat), dLng = Number(destPax?.lng);
  const cOLat = Number(carOrig?.lat), cOLng = Number(carOrig?.lng);
  const cDLat = Number(carDest?.lat), cDLng = Number(carDest?.lng);
  if (![oLat, oLng, dLat, dLng, cOLat, cOLng, cDLat, cDLng].every(Number.isFinite)) return null;

  const totalPax = haversineKmCoord(oLat, oLng, dLat, dLng);
  if (!(totalPax > 0)) return null;

  // Embarque: progresso do pax na carona (km desde a origem do motorista).
  const dEmb = pontoNoCaminho(cOLat, cOLng, oLat, oLng, cDLat, cDLng)
    ? haversineKmCoord(cOLat, cOLng, oLat, oLng)
    : 0;

  const noCaminho = pontosNoCaminhoCarona(cOLat, cOLng, cDLat, cDLng, locais);
  let melhor = null;
  for (const p of noCaminho) {
    if (!p.nome) continue;
    // À frente do embarque (com folga).
    if (p.dOrig + 0.05 < dEmb) continue;
    const restante = haversineKmCoord(p.lat, p.lng, dLat, dLng);
    const avanco = totalPax - restante;
    if (avanco < ENCAIXE_AVANCO_MIN_KM) continue;
    if (restante <= RAIO_MESMO_DEST_KM) continue; // seria total, não encaixe
    if (!melhor || restante < melhor.restante_km) {
      melhor = { nome: p.nome, lat: p.lat, lng: p.lng, restante_km: restante, avanco_km: avanco };
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
  desvioCaminhoKm,
  pontoNoCaminho,
  pontosNoCaminhoCarona,
  expandirRotaPista,
  corredorPolilinhaKm,
  corredorRotaCaronaKm,
  compatRotaPassageiro,
  ENCAIXE_AVANCO_MIN_KM,
  _catalogoLocais,
  locaisDoProjetoCodigo,
  _codigoProjetoCache,
  codigoDoProjeto,
  melhorPontoDeEncaixe,
  haversineKmCoord,
};
