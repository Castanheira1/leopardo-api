// Listagem de pedidos no mapa do motorista (pulso + match) — mesmos filtros operacionais.
require("dotenv").config();
const { RAIO_ONLINE_KM, RAIO_VISIVEL_KM } = require("../config");
const { pool } = require("../db");
const {
  codigoDoProjeto, compatRotaPassageiro, haversine,
  locaisDoProjetoCodigo, melhorPontoDeEncaixe, somarDesvioAcumulado,
} = require("../geo");

/**
 * @param {{ pid: number, motoristaId: number, lat: number, lng: number }} opts
 */
async function listarPedidosMapaMotorista({ pid, motoristaId, lat, lng }) {
  const temCarona = (await pool.query(
    `SELECT raio_km, origem_lat, origem_lng, destino_lat, destino_lng, destino_texto, rota_pontos
     FROM caronas WHERE motorista_id = $1 AND status = 'ativa'
     ORDER BY created_at DESC LIMIT 1`,
    [motoristaId]
  )).rows[0];
  const raioKm = temCarona ? (Number(temCarona.raio_km) || RAIO_VISIVEL_KM) : RAIO_ONLINE_KM;
  const distOrigem = haversine("p.origem_lat", "p.origem_lng", "$1", "$2");
  const params = [lat, lng, raioKm, pid, motoristaId];
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT p.*, u.nome AS passageiro_nome, u.sexo AS passageiro_sexo,
              ${distOrigem} AS dist_origem
       FROM pedidos p
       JOIN usuarios u ON p.passageiro_id = u.id
       WHERE p.status = 'aberto'
         AND COALESCE(u.ativo, TRUE) = TRUE
         AND (p.horario IS NULL OR p.horario <= NOW())
         AND COALESCE(p.horario, p.created_at) > NOW() - INTERVAL '30 minutes'
         AND NOT EXISTS (SELECT 1 FROM viagens v
                         WHERE v.passageiro_id = p.passageiro_id AND v.status = 'em_andamento')
         AND NOT EXISTS (SELECT 1 FROM pedido_fila f
                         WHERE f.pedido_id = p.id
                           AND f.status IN ('aguardando', 'ofertada')
                           AND f.exclusiva)
         AND NOT EXISTS (SELECT 1 FROM pedido_fila fr
                         WHERE fr.pedido_id = p.id
                           AND fr.motorista_id = $5
                           AND fr.status = 'recusada')
         AND u.projeto_id = $4
     ) s
     WHERE s.dist_origem <= $3
     ORDER BY s.dist_origem ASC
     LIMIT 60`,
    params
  );

  const caronaMot = temCarona;
  const codPed = await codigoDoProjeto(pid);
  const locaisEnc = caronaMot?.destino_lat != null ? locaisDoProjetoCodigo(codPed) : [];
  const caOrigMot = caronaMot
    ? { lat: +caronaMot.origem_lat, lng: +caronaMot.origem_lng }
    : null;
  const caDestMot = caronaMot
    ? { lat: +caronaMot.destino_lat, lng: +caronaMot.destino_lng }
    : null;
  const optsRota = {
    locais: locaisEnc,
    codigo: codPed,
    rota_pontos: caronaMot?.rota_pontos || null,
  };

  let desvioJaMot = 0;
  if (caronaMot && caOrigMot && caDestMot) {
    try {
      const { rows: paradas } = await pool.query(
        `SELECT destino_motorista_lat AS lat, destino_motorista_lng AS lng,
                destino_motorista_texto AS nome
         FROM viagens
         WHERE motorista_id = $1 AND status = 'em_andamento'
           AND destino_motorista_lat IS NOT NULL`,
        [motoristaId]
      );
      desvioJaMot = somarDesvioAcumulado(caOrigMot, caDestMot, paradas.map((x) => ({
        lat: Number(x.lat), lng: Number(x.lng), nome: x.nome || null,
      })), optsRota);
    } catch (_) { /* ok */ }
  }

  return rows.map((p) => {
    if (!caronaMot?.destino_lat || p.destino_lat == null) return p;
    const compat = compatRotaPassageiro(
      p.destino_lat, p.destino_lng,
      caronaMot.origem_lat, caronaMot.origem_lng,
      caronaMot.destino_lat, caronaMot.destino_lng,
      {
        ...optsRota,
        origPax: p.origem_lat != null
          ? { lat: +p.origem_lat, lng: +p.origem_lng, nome: p.origem_texto || null }
          : undefined,
      }
    );
    if (compat === "none" && p.origem_lat != null) {
      const enc = melhorPontoDeEncaixe(
        { lat: +p.origem_lat, lng: +p.origem_lng },
        { lat: +p.destino_lat, lng: +p.destino_lng },
        caOrigMot, caDestMot,
        { ...optsRota, desvio_acumulado_km: desvioJaMot }
      );
      if (enc) {
        return {
          ...p,
          compat_rota: "encaixe",
          destino_motorista_texto: caronaMot.destino_texto,
          encaixe_texto: enc.nome || caronaMot.destino_texto || null,
          encaixe_lat: enc.lat,
          encaixe_lng: enc.lng,
        };
      }
    }
    return {
      ...p,
      compat_rota: compat,
      destino_motorista_texto: caronaMot.destino_texto,
    };
  });
}

module.exports = { listarPedidosMapaMotorista };
