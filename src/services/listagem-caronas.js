// Listagem de caronas para passageiro (mapa + match) — mesma lógica de encaixe/malha.
require("dotenv").config();
const { RAIO_MESMO_DEST_KM, RAIO_ROTA_KM, RAIO_VISIVEL_KM, sqlGpsVisivelMapa } = require("../config");
const { pool } = require("../db");
const {
  codigoDoProjeto, compatRotaPassageiro, corredorRotaCaronaKm,
  haversine, haversineKmCoord, locaisDoProjetoCodigo,
  melhorPontoDeEncaixe, somarDesvioAcumulado,
  sqlCorredorSegmento, sqlDestinoProximoCarona,
} = require("../geo");

/**
 * @param {{ pid: number, excludeUserId?: number, lat?: number|null, lng?: number|null,
 *           dest_lat?: number|null, dest_lng?: number|null }} opts
 */
async function listarCaronasParaPassageiro({ pid, excludeUserId, lat, lng, dest_lat, dest_lng }) {
  const temPos = lat != null && lng != null;
  const temDest = dest_lat != null && dest_lng != null;
  const params = [];

  let distSel = "";
  if (temPos) {
    params.push(lat, lng);
    distSel = `, ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} AS dist_origem`;
  }

  let destFiltro = "";
  let origemRaio = "";
  let compatSel = "";
  if (temDest) {
    params.push(dest_lat, dest_lng);
    const dl = `$${params.length - 1}`;
    const dg = `$${params.length}`;
    const corPax = sqlCorredorSegmento(dl, dg, "c.origem_lat", "c.origem_lng", "c.destino_lat", "c.destino_lng", RAIO_ROTA_KM);
    const mesmoDest = `${haversine("c.destino_lat", "c.destino_lng", dl, dg)} <= ${RAIO_MESMO_DEST_KM}`;
    const compatTotal = `(${mesmoDest} OR ${corPax.noSegmento})`;
    const compatParcial = corPax.alemDestino;
    const compatProximo = sqlDestinoProximoCarona(dl, dg, "c.origem_lat", "c.origem_lng", "c.destino_lat", "c.destino_lng");
    destFiltro = "AND c.vagas > 0";
    compatSel = `, CASE WHEN ${compatTotal} THEN 'total' WHEN ${compatParcial} THEN 'parcial' WHEN ${compatProximo} THEN 'proximo' ELSE 'none' END AS compat_rota`;
  } else if (temPos) {
    origemRaio = `AND ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} <= COALESCE(c.raio_km, ${RAIO_VISIVEL_KM})`;
  }

  params.push(pid);
  const filtroProj = `AND u.projeto_id = $${params.length}`;
  let excludeSql = "";
  if (excludeUserId) {
    params.push(excludeUserId);
    excludeSql = `AND c.motorista_id <> $${params.length}`;
  }
  const orderBy = temPos ? "dist_origem ASC" : "c.created_at DESC";

  const { rows } = await pool.query(
    `SELECT c.*, u.nome AS motorista_nome, u.empresa_nome AS motorista_empresa,
            h.placa, h.tag, h.foto_carro_url,
            (lo.disponivel = TRUE) AS motorista_online,
            (SELECT COUNT(*)::int FROM viagens vv
             WHERE vv.motorista_id = c.motorista_id AND vv.status = 'em_andamento'
               AND vv.carona_id IS NULL) AS viagens_fora_carona ${distSel}${compatSel}
     FROM caronas c
     JOIN usuarios u ON c.motorista_id = u.id
     LEFT JOIN habilitacoes_motorista h ON c.habilitacao_id = h.id
     JOIN localizacoes_online lo ON lo.usuario_id = c.motorista_id
     WHERE c.status = 'ativa' AND COALESCE(u.ativo, TRUE) = TRUE
       AND lo.disponivel = TRUE
       AND ${sqlGpsVisivelMapa("lo")}
       AND c.id = (
         SELECT cx.id FROM caronas cx
         WHERE cx.motorista_id = c.motorista_id AND cx.status = 'ativa'
         ORDER BY cx.created_at DESC LIMIT 1
       )
       ${filtroProj}
       ${excludeSql}
       ${origemRaio}
       ${destFiltro}
     ORDER BY ${orderBy}`,
    params
  );

  if (!temDest) {
    return rows.filter((c) => {
      const fora = Number(c.viagens_fora_carona) || 0;
      return (c.vagas || 0) - fora > 0;
    });
  }

  const origPax = temPos ? { lat: +lat, lng: +lng } : null;
  const destPax = { lat: +dest_lat, lng: +dest_lng };
  const cod = await codigoDoProjeto(pid);
  const locais = locaisDoProjetoCodigo(cod);

  const idsMot = [...new Set(rows.map((c) => c.motorista_id).filter(Boolean))];
  const paradasPorMot = new Map();
  if (idsMot.length) {
    try {
      const { rows: paradas } = await pool.query(
        `SELECT motorista_id, destino_motorista_lat AS lat, destino_motorista_lng AS lng,
                destino_motorista_texto AS nome
         FROM viagens
         WHERE status = 'em_andamento'
           AND destino_motorista_lat IS NOT NULL
           AND motorista_id = ANY($1::int[])`,
        [idsMot]
      );
      for (const p of paradas) {
        if (!paradasPorMot.has(p.motorista_id)) paradasPorMot.set(p.motorista_id, []);
        paradasPorMot.get(p.motorista_id).push({
          lat: Number(p.lat), lng: Number(p.lng), nome: p.nome || null,
        });
      }
    } catch (e) {
      console.warn("listarCaronasParaPassageiro desvio:", e.message);
    }
  }

  const comEncaixe = [];
  for (const c of rows) {
    const fora = Number(c.viagens_fora_carona) || 0;
    if ((c.vagas || 0) - fora <= 0) continue;
    if (c.origem_lat == null || c.destino_lat == null) {
      if (c.compat_rota !== "none") comEncaixe.push(c);
      continue;
    }
    const caOrig = { lat: +c.origem_lat, lng: +c.origem_lng };
    const caDest = { lat: +c.destino_lat, lng: +c.destino_lng };
    const optsRota = { locais, codigo: cod, rota_pontos: c.rota_pontos || null };
    const compatJs = compatRotaPassageiro(
      destPax.lat, destPax.lng,
      caOrig.lat, caOrig.lng, caDest.lat, caDest.lng,
      { ...optsRota, origPax: origPax || undefined }
    );
    if (compatJs !== "none") {
      comEncaixe.push({ ...c, compat_rota: compatJs });
      continue;
    }
    if (!origPax) continue;
    const cor = corredorRotaCaronaKm(
      origPax.lat, origPax.lng,
      caOrig.lat, caOrig.lng, caDest.lat, caDest.lng,
      optsRota
    );
    const noCorredor = cor.dist <= RAIO_ROTA_KM && cor.t >= -0.05 && cor.t <= 1.05;
    const distOrigemCarona = haversineKmCoord(origPax.lat, origPax.lng, caOrig.lat, caOrig.lng);
    if (!noCorredor && distOrigemCarona > (Number(c.raio_km) || RAIO_VISIVEL_KM)) continue;
    const desvioJa = somarDesvioAcumulado(
      caOrig, caDest,
      paradasPorMot.get(c.motorista_id) || [],
      optsRota
    );
    const enc = melhorPontoDeEncaixe(
      origPax, destPax, caOrig, caDest,
      { ...optsRota, desvio_acumulado_km: desvioJa }
    );
    if (!enc) continue;
    comEncaixe.push({
      ...c,
      compat_rota: "encaixe",
      encaixe_texto: enc.nome || c.destino_texto || null,
      encaixe_lat: enc.lat,
      encaixe_lng: enc.lng,
      encaixe_restante_km: Math.round(enc.restante_km * 10) / 10,
    });
  }
  return comEncaixe;
}

module.exports = { listarCaronasParaPassageiro };
