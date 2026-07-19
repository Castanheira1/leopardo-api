// Geometria de rota: haversine SQL + malha de pista (vias/troncos) + match.
// Com malha no locais-favoritos.json, a carona vira polilinha real (menor caminho).
// Sem malha, cai no desvio triangular O→P→D (legado 1452f00).
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

function sqlDestinoPassageiroNaCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const cor = sqlCorredorSegmento(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  const mesmo = `${haversine(carDestLat, carDestLng, pDestLat, pDestLng)} <= ${RAIO_MESMO_DEST_KM}`;
  return `(${mesmo} OR ${cor.noSegmento})`;
}

function sqlDestinoPassageiroAlemCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const cor = sqlCorredorSegmento(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  return cor.alemDestino;
}

function sqlPedidoCombinaComCarona(pOrigLat, pOrigLng, pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const destOk = sqlDestinoPassageiroNaCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng);
  const origCor = sqlCorredorSegmento(pOrigLat, pOrigLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  return `(${destOk} AND ${origCor.noSegmento})`;
}

function sqlPedidoCombinaComCaronaParcial(pOrigLat, pOrigLng, pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const destParcial = sqlDestinoPassageiroAlemCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng);
  const origCor = sqlCorredorSegmento(pOrigLat, pOrigLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  return `(${destParcial} AND ${origCor.noSegmento})`;
}

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

/* ==================== CATÁLOGO + MALHA ==================== */

const ENCAIXE_AVANCO_MIN_KM = Number(process.env.ENCAIXE_AVANCO_MIN_KM || 1);
const SNAP_NO_KM = Number(process.env.ROTA_SNAP_KM || 0.8);

let _catalogo = { mtimeMs: 0, porCodigo: {} };

function carregarCatalogo() {
  const arq = path.join(__dirname, "..", "public", "locais-favoritos.json");
  const st = fs.statSync(arq);
  if (st.mtimeMs === _catalogo.mtimeMs) return _catalogo.porCodigo;
  const bruto = JSON.parse(fs.readFileSync(arq, "utf8"));
  const porCodigo = {};
  Object.entries(bruto.projetos || {}).forEach(([cod, proj]) => {
    const locais = [];
    (proj.grupos || []).forEach((g) => (g.locais || []).forEach((l) => {
      if (l.ref && Number.isFinite(+l.ref.lat) && Number.isFinite(+l.ref.lng)) {
        locais.push({ nome: l.nome, lat: +l.ref.lat, lng: +l.ref.lng });
      }
    }));
    const malha = proj.malha || null;
    const grafo = malha ? construirGrafo(locais, malha) : null;
    porCodigo[cod.toUpperCase()] = { locais, malha, grafo };
  });
  _catalogo = { mtimeMs: st.mtimeMs, porCodigo };
  return porCodigo;
}

function catalogoDoProjeto(codigo) {
  if (!codigo) return { locais: [], malha: null, grafo: null };
  try {
    return carregarCatalogo()[String(codigo).toUpperCase()] || { locais: [], malha: null, grafo: null };
  } catch (e) {
    console.warn("catalogoDoProjeto:", e.message);
    return { locais: [], malha: null, grafo: null };
  }
}

function locaisDoProjetoCodigo(codigo) {
  return catalogoDoProjeto(codigo).locais;
}

function construirGrafo(locais, malha) {
  const byNome = new Map(locais.map((l) => [l.nome, l]));
  const adj = new Map(); // nome -> [{ nome, km }]
  const addEdge = (a, b, kmOpt) => {
    const na = byNome.get(a);
    const nb = byNome.get(b);
    if (!na || !nb || a === b) return;
    const km = Number.isFinite(+kmOpt) && +kmOpt > 0
      ? +kmOpt
      : haversineKmCoord(na.lat, na.lng, nb.lat, nb.lng);
    if (!(km > 0)) return;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    // evita duplicata mais cara
    const ia = adj.get(a).findIndex((e) => e.nome === b);
    if (ia >= 0) {
      if (km < adj.get(a)[ia].km) {
        adj.get(a)[ia].km = km;
        const ib = adj.get(b).findIndex((e) => e.nome === a);
        if (ib >= 0) adj.get(b)[ib].km = km;
      }
      return;
    }
    adj.get(a).push({ nome: b, km });
    adj.get(b).push({ nome: a, km });
  };

  for (const tronco of malha.troncos || []) {
    if (!Array.isArray(tronco)) continue;
    for (let i = 0; i < tronco.length - 1; i++) addEdge(tronco[i], tronco[i + 1]);
  }
  for (const e of malha.arestas || []) {
    if (!e) continue;
    const a = e.a || e.de;
    const b = e.b || e.para;
    if (a && b) addEdge(a, b, e.km);
  }
  // malha local: liga pontos próximos (usina densa, etc.)
  const localKm = Number(malha.malha_local_km);
  if (Number.isFinite(localKm) && localKm > 0) {
    for (let i = 0; i < locais.length; i++) {
      for (let j = i + 1; j < locais.length; j++) {
        const d = haversineKmCoord(locais[i].lat, locais[i].lng, locais[j].lat, locais[j].lng);
        if (d > 0.05 && d <= localKm) addEdge(locais[i].nome, locais[j].nome, d);
      }
    }
  }
  return { adj, byNome };
}

function dijkstra(grafo, origemNome, destinoNome) {
  if (!grafo || !origemNome || !destinoNome) return null;
  if (origemNome === destinoNome) {
    const n = grafo.byNome.get(origemNome);
    return n ? { nomes: [origemNome], km: 0 } : null;
  }
  if (!grafo.adj.has(origemNome) || !grafo.adj.has(destinoNome)) return null;

  const dist = new Map();
  const prev = new Map();
  const used = new Set();
  for (const n of grafo.adj.keys()) dist.set(n, Infinity);
  dist.set(origemNome, 0);

  for (;;) {
    let u = null;
    let best = Infinity;
    for (const [n, d] of dist) {
      if (!used.has(n) && d < best) {
        best = d;
        u = n;
      }
    }
    if (u == null || u === destinoNome) break;
    used.add(u);
    for (const e of grafo.adj.get(u) || []) {
      const nd = best + e.km;
      if (nd < (dist.get(e.nome) ?? Infinity)) {
        dist.set(e.nome, nd);
        prev.set(e.nome, u);
      }
    }
  }
  if (!Number.isFinite(dist.get(destinoNome))) return null;
  const nomes = [];
  let cur = destinoNome;
  while (cur) {
    nomes.push(cur);
    cur = prev.get(cur);
  }
  nomes.reverse();
  return { nomes, km: dist.get(destinoNome) };
}

function noMaisProximo(lat, lng, locais, maxKm = SNAP_NO_KM) {
  let best = null;
  let bestD = Infinity;
  for (const p of locais || []) {
    const d = haversineKmCoord(lat, lng, p.lat, p.lng);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (!best || bestD > maxKm) return null;
  return { ...best, dist_km: bestD };
}

/**
 * Calcula a rota da carona na malha do projeto.
 * @returns {{ pontos: {nome,lat,lng}[], km: number, fonte: 'malha'|'reta', nomes?: string[] }}
 */
function calcularRotaCarona(orig, dest, codigoProjeto) {
  const oLat = Number(orig?.lat ?? orig?.origem_lat);
  const oLng = Number(orig?.lng ?? orig?.origem_lng);
  const dLat = Number(dest?.lat ?? dest?.destino_lat);
  const dLng = Number(dest?.lng ?? dest?.destino_lng);
  const oNome = orig?.nome || orig?.origem_texto || null;
  const dNome = dest?.nome || dest?.destino_texto || null;
  if (![oLat, oLng, dLat, dLng].every(Number.isFinite)) {
    return { pontos: [], km: 0, fonte: "reta" };
  }

  const cat = catalogoDoProjeto(codigoProjeto);
  const reta = () => ({
    pontos: [
      { nome: oNome, lat: oLat, lng: oLng },
      { nome: dNome, lat: dLat, lng: dLng },
    ],
    km: haversineKmCoord(oLat, oLng, dLat, dLng),
    fonte: "reta",
  });

  if (!cat.grafo || cat.locais.length === 0) return reta();

  // Snap: nome exato no catálogo ou nó mais próximo.
  const snapO = (oNome && cat.grafo.byNome.get(oNome))
    ? cat.grafo.byNome.get(oNome)
    : noMaisProximo(oLat, oLng, cat.locais);
  const snapD = (dNome && cat.grafo.byNome.get(dNome))
    ? cat.grafo.byNome.get(dNome)
    : noMaisProximo(dLat, dLng, cat.locais);
  if (!snapO || !snapD) return reta();

  const path = dijkstra(cat.grafo, snapO.nome, snapD.nome);
  if (!path || !path.nomes.length) return reta();

  const pontos = path.nomes.map((nome) => {
    const n = cat.grafo.byNome.get(nome);
    return { nome, lat: n.lat, lng: n.lng };
  });
  // Garante pontas reais da carona (GPS/pin) se diferirem do nó.
  if (haversineKmCoord(oLat, oLng, pontos[0].lat, pontos[0].lng) > 0.05) {
    pontos.unshift({ nome: oNome, lat: oLat, lng: oLng });
  } else {
    pontos[0] = { ...pontos[0], nome: oNome || pontos[0].nome };
  }
  const last = pontos[pontos.length - 1];
  if (haversineKmCoord(dLat, dLng, last.lat, last.lng) > 0.05) {
    pontos.push({ nome: dNome, lat: dLat, lng: dLng });
  } else {
    pontos[pontos.length - 1] = { ...last, nome: dNome || last.nome };
  }

  let km = 0;
  for (let i = 0; i < pontos.length - 1; i++) {
    km += haversineKmCoord(pontos[i].lat, pontos[i].lng, pontos[i + 1].lat, pontos[i + 1].lng);
  }
  return { pontos, km, fonte: "malha", nomes: path.nomes };
}

function normalizarRotaPontos(rotaPontos) {
  if (!rotaPontos) return null;
  let arr = rotaPontos;
  if (typeof arr === "string") {
    try { arr = JSON.parse(arr); } catch (_) { return null; }
  }
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const pts = arr.map((p) => ({
    nome: p.nome || p.texto || null,
    lat: Number(p.lat),
    lng: Number(p.lng),
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  return pts.length >= 2 ? pts : null;
}

/** Distância (km) de um ponto até a polilinha; t ∈ ℝ ao longo do comprimento. */
function corredorPolilinhaKm(lat, lng, pts) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || !Array.isArray(pts) || pts.length < 2) {
    return { t: 0, dist: Infinity };
  }
  let total = 0;
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = haversineKmCoord(a.lat, a.lng, b.lat, b.lng);
    segs.push({ a, b, len: len > 1e-9 ? len : 1e-9 });
    total += len > 1e-9 ? len : 0;
  }
  if (!(total > 0)) {
    return { t: 0, dist: haversineKmCoord(la, ln, pts[0].lat, pts[0].lng) };
  }
  let bestDist = Infinity;
  let bestT = 0;
  let bestAlem = false;
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const { a, b, len } = segs[i];
    const cor = corredorSegmentoKm(la, ln, a.lat, a.lng, b.lat, b.lng);
    const tClamp = Math.min(1, Math.max(0, cor.t));
    const dist = cor.dist;
    const tGlobal = (acc + tClamp * len) / total;
    const alem = i === segs.length - 1 && cor.t > 1;
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) < 1e-9 && alem)) {
      bestDist = dist;
      bestT = alem
        ? Math.max(1.0001, (acc + len) / total + (cor.t - 1) * (len / total))
        : tGlobal;
      bestAlem = alem;
    }
    acc += len;
  }
  if (bestAlem && bestT <= 1) bestT = 1.0001;
  return { t: bestT, dist: bestDist };
}

function comprimentoPolilinhaKm(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return 0;
  let k = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    k += haversineKmCoord(pts[i].lat, pts[i].lng, pts[i + 1].lat, pts[i + 1].lng);
  }
  return k;
}

/* ==================== LEGADO: desvio triangular (sem malha) ==================== */

function desvioCaminhoKm(oLat, oLng, pLat, pLng, dLat, dLng) {
  const base = haversineKmCoord(oLat, oLng, dLat, dLng);
  const d1 = haversineKmCoord(oLat, oLng, pLat, pLng);
  const d2 = haversineKmCoord(pLat, pLng, dLat, dLng);
  if (!(base > 0.01)) return d1;
  return d1 + d2 - base;
}

function pontoNoCaminho(oLat, oLng, pLat, pLng, dLat, dLng, desvioMax) {
  const oLa = Number(oLat), oLn = Number(oLng);
  const pLa = Number(pLat), pLn = Number(pLng);
  const dLa = Number(dLat), dLn = Number(dLng);
  if (![oLa, oLn, pLa, pLn, dLa, dLn].every(Number.isFinite)) return false;
  const max = Number.isFinite(desvioMax) ? desvioMax
    : (Number.isFinite(ROTA_DESVIO_MAX_KM) ? ROTA_DESVIO_MAX_KM : 1.8);
  const base = haversineKmCoord(oLa, oLn, dLa, dLn);
  const d1 = haversineKmCoord(oLa, oLn, pLa, pLn);
  const d2 = haversineKmCoord(pLa, pLn, dLa, dLn);
  if (!(base > 0.01)) return d1 <= RAIO_ROTA_KM;
  if (d1 + d2 > base + max) return false;
  if (d1 > base + max * 0.35) return false;
  return true;
}

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

function expandirRotaPista(carOrigLat, carOrigLng, carDestLat, carDestLng, locais, codigo) {
  if (codigo) {
    const r = calcularRotaCarona(
      { lat: carOrigLat, lng: carOrigLng },
      { lat: carDestLat, lng: carDestLng },
      codigo
    );
    if (r.fonte === "malha" && r.pontos.length >= 2) return r.pontos;
  }
  const oLat = Number(carOrigLat), oLng = Number(carOrigLng);
  const dLat = Number(carDestLat), dLng = Number(carDestLng);
  if (![oLat, oLng, dLat, dLng].every(Number.isFinite)) return [];
  const inicio = { lat: oLat, lng: oLng, nome: null };
  const fim = { lat: dLat, lng: dLng, nome: null };
  const vias = pontosNoCaminhoCarona(oLat, oLng, dLat, dLng, locais)
    .filter((p) => p.dOrig >= 0.08 && haversineKmCoord(p.lat, p.lng, dLat, dLng) >= 0.08);
  return [inicio, ...vias.map(({ lat, lng, nome }) => ({ lat, lng, nome })), fim];
}

/**
 * Resolve polilinha da carona: rota_pontos gravada > malha calculada > reta.
 * opts: { rota_pontos, codigo, locais }
 */
function polilinhaDaCarona(carOrigLat, carOrigLng, carDestLat, carDestLng, opts = {}) {
  const gravada = normalizarRotaPontos(opts.rota_pontos);
  if (gravada) return gravada;
  if (opts.codigo) {
    const r = calcularRotaCarona(
      { lat: carOrigLat, lng: carOrigLng },
      { lat: carDestLat, lng: carDestLng },
      opts.codigo
    );
    if (r.pontos.length >= 2) return r.pontos;
  }
  return expandirRotaPista(carOrigLat, carOrigLng, carDestLat, carDestLng, opts.locais || []);
}

function parseOpts(locaisOrOpts) {
  if (Array.isArray(locaisOrOpts)) return { locais: locaisOrOpts };
  if (locaisOrOpts && typeof locaisOrOpts === "object") return locaisOrOpts;
  return {};
}

/**
 * Corredor na polilinha da carona (malha/gravada) ou desvio legado.
 */
function corredorRotaCaronaKm(lat, lng, carOrigLat, carOrigLng, carDestLat, carDestLng, locaisOrOpts) {
  const opts = parseOpts(locaisOrOpts);
  // Malha / rota gravada: corredor na polilinha real.
  if (opts.rota_pontos || opts.codigo) {
    const poly = polilinhaDaCarona(carOrigLat, carOrigLng, carDestLat, carDestLng, opts);
    if (poly.length >= 2) return corredorPolilinhaKm(lat, lng, poly);
  }
  // Legado triangular
  const la = Number(lat), ln = Number(lng);
  const oLat = Number(carOrigLat), oLng = Number(carOrigLng);
  const dLat = Number(carDestLat), dLng = Number(carDestLng);
  if (![la, ln, oLat, oLng, dLat, dLng].every(Number.isFinite)) {
    return { t: 0, dist: Infinity };
  }
  const base = haversineKmCoord(oLat, oLng, dLat, dLng);
  const dOrig = haversineKmCoord(oLat, oLng, la, ln);
  if (pontoNoCaminho(oLat, oLng, la, ln, dLat, dLng)) {
    return { t: base > 0.01 ? Math.min(1, Math.max(0, dOrig / base)) : 0, dist: 0 };
  }
  if (base > 0.01 && pontoNoCaminho(oLat, oLng, dLat, dLng, la, ln)) {
    return { t: 1 + haversineKmCoord(dLat, dLng, la, ln) / base, dist: 0 };
  }
  return corredorSegmentoKm(la, ln, oLat, oLng, dLat, dLng);
}

/**
 * Compat do destino do passageiro com a rota do motorista.
 * 7º arg: locais[] OU { locais, rota_pontos, codigo }
 */
function compatRotaPassageiro(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng, locaisOrOpts) {
  const opts = parseOpts(locaisOrOpts);
  const dl = Number(pDestLat);
  const dg = Number(pDestLng);
  const oLat = Number(carOrigLat);
  const oLng = Number(carOrigLng);
  const dLat = Number(carDestLat);
  const dLng = Number(carDestLng);
  if (![dl, dg, oLat, oLng, dLat, dLng].every(Number.isFinite)) return "none";

  if (haversineKmCoord(dLat, dLng, dl, dg) <= RAIO_MESMO_DEST_KM) return "total";

  // Com malha/rota gravada: distância à polilinha real.
  if (opts.rota_pontos || opts.codigo) {
    const poly = polilinhaDaCarona(oLat, oLng, dLat, dLng, opts);
    const cor = corredorPolilinhaKm(dl, dg, poly);
    if (cor.dist <= RAIO_ROTA_KM && cor.t >= 0 && cor.t <= 1) return "total";
    if (cor.dist <= RAIO_ROTA_KM && cor.t > 1) return "parcial";
    // Parcial por malha: destino do motorista está no caminho do pax na malha.
    if (opts.codigo) {
      const rotaPax = calcularRotaCarona(
        { lat: oLat, lng: oLng },
        { lat: dl, lng: dg },
        opts.codigo
      );
      if (rotaPax.fonte === "malha" && rotaPax.nomes && rotaPax.nomes.length) {
        const snapD = noMaisProximo(dLat, dLng, catalogoDoProjeto(opts.codigo).locais);
        if (snapD && rotaPax.nomes.includes(snapD.nome)
          && haversineKmCoord(dLat, dLng, dl, dg) > RAIO_MESMO_DEST_KM) {
          const idx = rotaPax.nomes.indexOf(snapD.nome);
          if (idx >= 0 && idx < rotaPax.nomes.length - 1) return "parcial";
        }
      }
    }
    const pertoDest = haversineKmCoord(dLat, dLng, dl, dg) <= RAIO_PROXIMO_KM;
    const pertoCor = cor.dist <= RAIO_PROXIMO_KM;
    if (pertoDest || pertoCor) return "proximo";
    return "none";
  }

  // Legado (sem codigo/rota_pontos)
  if (pontoNoCaminho(oLat, oLng, dl, dg, dLat, dLng)) return "total";
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

/**
 * Encaixe: local no caminho da carona (polilinha) que adianta o pax.
 * Com malha, desvio_km = km(caminho com parada em P) − km(caminho original).
 */
function melhorPontoDeEncaixe(origPax, destPax, carOrig, carDest, locaisOrOpts, desvioAcumuladoKm = 0) {
  const opts = parseOpts(locaisOrOpts);
  const oLat = Number(origPax?.lat), oLng = Number(origPax?.lng);
  const dLat = Number(destPax?.lat), dLng = Number(destPax?.lng);
  const cOLat = Number(carOrig?.lat), cOLng = Number(carOrig?.lng);
  const cDLat = Number(carDest?.lat), cDLng = Number(carDest?.lng);
  if (![oLat, oLng, dLat, dLng, cOLat, cOLng, cDLat, cDLng].every(Number.isFinite)) return null;

  const totalPax = haversineKmCoord(oLat, oLng, dLat, dLng);
  if (!(totalPax > 0)) return null;

  const poly = polilinhaDaCarona(cOLat, cOLng, cDLat, cDLng, opts);
  const kmBase = comprimentoPolilinhaKm(poly);
  const desvioMax = Number.isFinite(ROTA_DESVIO_MAX_KM) ? ROTA_DESVIO_MAX_KM : 1.8;
  const desvioJa = Number(desvioAcumuladoKm) || 0;

  const corEmb = corredorPolilinhaKm(oLat, oLng, poly);
  const tEmb = Math.min(1, Math.max(0, Number.isFinite(corEmb.t) ? corEmb.t : 0));

  const locais = opts.locais || [];
  let melhor = null;
  for (const p of locais) {
    if (!p?.nome) continue;
    const lat = Number(p.lat), lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const cor = corredorPolilinhaKm(lat, lng, poly);
    if (!(cor.dist <= RAIO_ROTA_KM && cor.t >= tEmb - 0.02 && cor.t <= 1.05)) continue;

    const restante = haversineKmCoord(lat, lng, dLat, dLng);
    const avanco = totalPax - restante;
    if (avanco < ENCAIXE_AVANCO_MIN_KM) continue;
    if (restante <= RAIO_MESMO_DEST_KM) continue;

    // Custo de desvio: na malha, recalcula O→P→D; senão triângulo.
    let desvioExtra = 0;
    if (opts.codigo && catalogoDoProjeto(opts.codigo).grafo) {
      const viaP = calcularRotaCarona(
        { lat: cOLat, lng: cOLng },
        { lat, lng, nome: p.nome },
        opts.codigo
      );
      const pToD = calcularRotaCarona(
        { lat, lng, nome: p.nome },
        { lat: cDLat, lng: cDLng },
        opts.codigo
      );
      if (viaP.fonte === "malha" && pToD.fonte === "malha") {
        desvioExtra = (viaP.km + pToD.km) - kmBase;
      } else {
        desvioExtra = desvioCaminhoKm(cOLat, cOLng, lat, lng, cDLat, cDLng);
      }
    } else {
      desvioExtra = desvioCaminhoKm(cOLat, cOLng, lat, lng, cDLat, cDLng);
    }
    if (desvioExtra < 0) desvioExtra = 0;
    if (desvioJa + desvioExtra > desvioMax + 0.01) continue;

    if (!melhor || restante < melhor.restante_km) {
      melhor = {
        nome: p.nome,
        lat,
        lng,
        restante_km: restante,
        avanco_km: avanco,
        desvio_km: desvioExtra,
        desvio_acumulado_km: desvioJa + desvioExtra,
      };
    }
  }
  return melhor;
}

// Alias legado
const _catalogoLocais = _catalogo;

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
  catalogoDoProjeto,
  calcularRotaCarona,
  normalizarRotaPontos,
  polilinhaDaCarona,
  comprimentoPolilinhaKm,
  _codigoProjetoCache,
  codigoDoProjeto,
  melhorPontoDeEncaixe,
  haversineKmCoord,
};
