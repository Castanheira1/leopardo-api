// Localização ao vivo, modo motorista online (amarelo) e motoristas visíveis no mapa/rota.
require("dotenv").config();
const app = require("../app");
const { RAIO_ONLINE_KM, RAIO_VISIVEL_KM, SQL_GPS_FRESH, SQL_GPS_STALE, sqlGpsVisivelMapa } = require("../config");
const { pool } = require("../db");
const { verificarAuth } = require("../auth");
const { habilitacaoAtiva, projetoDoUsuario, registrarEventoUso, sqlSelfieValida } = require("../usuarios");
const { haversine, sqlMotoristaNaRotaPassageiro } = require("../geo");

/* ===================== LOCALIZAÇÃO AO VIVO (modo Uber) ===================== */
// Cada usuário publica sua posição atual (a cada poucos segundos pelo app).
app.post("/api/localizacao", verificarAuth, async (req, res) => {
  const nlat = Number(req.body.lat);
  const nlng = Number(req.body.lng);
  if (!Number.isFinite(nlat) || !Number.isFinite(nlng) ||
      nlat < -90 || nlat > 90 || nlng < -180 || nlng > 180) {
    return res.status(400).json({ error: "Coordenadas inválidas" });
  }
  try {
    await pool.query(
      `INSERT INTO localizacoes_online (usuario_id, lat, lng, disponivel, atualizado_em)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (usuario_id)
       DO UPDATE SET lat = $2, lng = $3, disponivel = $4, atualizado_em = NOW()`,
      [req.user.id, nlat, nlng, req.body.disponivel !== false]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar localização" });
  }
});

// Para o app deixar de transmitir (ficar offline no mapa).
app.delete("/api/localizacao", verificarAuth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE localizacoes_online SET disponivel = FALSE, online_desde = NULL WHERE usuario_id = $1",
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro" });
  }
});

/* ===================== MOTORISTA ONLINE (sem destino) ===================== */
app.get("/api/motorista/online", verificarAuth, async (req, res) => {
  try {
    const hab = await habilitacaoAtiva(req.user.id);
    const row = (await pool.query(
      `SELECT l.disponivel, l.lat, l.lng, l.atualizado_em, l.online_desde, l.vagas,
              (SELECT id FROM caronas WHERE motorista_id = $1 AND status = 'ativa' ORDER BY created_at DESC LIMIT 1) AS carona_id
       FROM localizacoes_online l
       WHERE l.usuario_id = $1 AND l.disponivel = TRUE
         AND NOT (${SQL_GPS_STALE.replace("atualizado_em", "l.atualizado_em")})`,
      [req.user.id]
    )).rows[0];
    const online = !!(hab && row);
    res.json({
      online,
      lat: row?.lat != null ? +row.lat : null,
      lng: row?.lng != null ? +row.lng : null,
      online_desde: row?.online_desde || null,
      atualizado_em: row?.atualizado_em || null,
      vagas: row?.vagas != null ? +row.vagas : 1,
      carona_id: row?.carona_id || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao consultar status online" });
  }
});

app.post("/api/motorista/online", verificarAuth, async (req, res) => {
  const nlat = Number(req.body.lat);
  const nlng = Number(req.body.lng);
  const nvagas = Math.min(6, Math.max(parseInt(req.body.vagas, 10) || 1, 1));
  if (!Number.isFinite(nlat) || !Number.isFinite(nlng) ||
      nlat < -90 || nlat > 90 || nlng < -180 || nlng > 180) {
    return res.status(400).json({ error: "Coordenadas inválidas" });
  }
  try {
    const hab = await habilitacaoAtiva(req.user.id);
    if (!hab) return res.status(403).json({ error: "Ative o modo motorista (foto do carro + selfie) antes de oferecer carona" });
    // Modo online sem destino substitui carona publicada com rota fixa.
    await pool.query(
      "UPDATE caronas SET status = 'cancelada' WHERE motorista_id = $1 AND status = 'ativa'",
      [req.user.id]
    );
    await pool.query(
      `INSERT INTO localizacoes_online (usuario_id, lat, lng, disponivel, online_desde, atualizado_em, vagas)
       VALUES ($1, $2, $3, TRUE, NOW(), NOW(), $4)
       ON CONFLICT (usuario_id)
       DO UPDATE SET lat = $2, lng = $3, disponivel = TRUE, online_desde = NOW(), atualizado_em = NOW(), vagas = $4`,
      [req.user.id, nlat, nlng, nvagas]
    );
    await registrarEventoUso(req.user.id, "motorista_modo_geral", { vagas: nvagas, lat: nlat, lng: nlng });
    res.json({ online: true, lat: nlat, lng: nlng, vagas: nvagas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao ficar online" });
  }
});

app.delete("/api/motorista/online", verificarAuth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE caronas SET status = 'cancelada' WHERE motorista_id = $1 AND status = 'ativa'",
      [req.user.id]
    );
    await pool.query(
      "UPDATE localizacoes_online SET disponivel = FALSE, online_desde = NULL WHERE usuario_id = $1",
      [req.user.id]
    );
    res.json({ online: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao sair do modo online" });
  }
});

// Modo amarelo (online_desde preenchido): nunca expõe carona/destino ao passageiro,
// mesmo se ainda existir registro ativo inconsistente no banco.
function motoristaVisivelPassageiro(row) {
  if (!row?.online_desde) return row;
  return {
    ...row,
    carona_id: null,
    origem_texto: null,
    destino_texto: null,
    origem_lat: null,
    origem_lng: null,
    destino_lat: null,
    destino_lng: null,
    carona_vagas: null,
  };
}

// Motoristas habilitados e online nos últimos 3 min (vistos pelo passageiro).
app.get("/api/motoristas-online", verificarAuth, async (req, res) => {
  const { lat, lng } = req.query;
  try {
    const pid = await projetoDoUsuario(req.user.id);
    // Sem projeto no cadastro o passageiro não vê ninguém (regra de isolamento).
    if (!pid) return res.json([]);
    const temPos = lat != null && lng != null && Number.isFinite(+lat) && Number.isFinite(+lng);
    const params = temPos
      ? [req.user.id, +lat, +lng, RAIO_ONLINE_KM, RAIO_VISIVEL_KM, pid]
      : [req.user.id, pid];
    const distExpr = haversine("lat", "lng", "$2", "$3");
    // Filtro de raio: 600 m modo amarelo (online_desde); 10 km rota publicada (carona).
    // Passageiro sem destino não consulta o mapa no front; com destino vê os dois tipos.
    const raio = temPos ? `WHERE (
      (online_desde IS NOT NULL AND ${distExpr} <= $4)
      OR (online_desde IS NULL AND carona_id IS NOT NULL AND ${distExpr} <= COALESCE(raio_km, $5))
    )` : "";
    const filtroProj = temPos ? `AND u.projeto_id = $6` : `AND u.projeto_id = $2`;
    const { rows } = await pool.query(
      `WITH candidatos AS (
         SELECT DISTINCT ON (u.id)
                u.id, u.nome, u.sexo, u.empresa_nome, l.lat, l.lng, l.vagas, l.online_desde,
                h.placa, h.tag, h.foto_carro_url, h.foto_carro_em, h.selfie_url, h.selfie_em,
                ca.id AS carona_id, ca.origem_texto, ca.destino_texto,
                ca.origem_lat, ca.origem_lng, ca.destino_lat, ca.destino_lng, ca.vagas AS carona_vagas,
                ca.raio_km
         FROM localizacoes_online l
         JOIN usuarios u ON u.id = l.usuario_id
         JOIN habilitacoes_motorista h
           ON h.motorista_id = u.id AND h.status = 'ativa'
              AND ${sqlSelfieValida("h")}
         LEFT JOIN LATERAL (
           SELECT id, origem_texto, destino_texto, origem_lat, origem_lng, destino_lat, destino_lng, vagas, raio_km
           FROM caronas
           WHERE motorista_id = u.id AND status = 'ativa'
           ORDER BY created_at DESC
           LIMIT 1
         ) ca ON TRUE
         WHERE l.disponivel = TRUE
           AND COALESCE(u.ativo, TRUE) = TRUE
           AND ${sqlGpsVisivelMapa("l")}
           AND u.id <> $1
           ${filtroProj}
         ORDER BY u.id, h.created_at DESC
       )
       SELECT * FROM candidatos
       ${raio}
       ORDER BY ${temPos ? distExpr : "id"}
       LIMIT 100`,
      params
    );
    res.json(rows.map(motoristaVisivelPassageiro));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar motoristas" });
  }
});

// Prévia (somente leitura) dos motoristas "na pista" da rota escolhida —
// mostra no mapa/lista ANTES mesmo de o passageiro publicar o pedido, do
// mais perto pro mais longe (mesma ordem em que a fila os chamaria).
app.get("/api/motoristas-rota", verificarAuth, async (req, res) => {
  const { origem_lat, origem_lng, destino_lat, destino_lng } = req.query;
  if (origem_lat == null || origem_lng == null || destino_lat == null || destino_lng == null) {
    return res.status(400).json({ error: "Origem e destino são obrigatórios" });
  }
  try {
    const pid = await projetoDoUsuario(req.user.id);
    if (!pid) return res.json([]);
    const distOrigem = haversine("l.lat", "l.lng", "$2", "$3");
    const naPista = sqlMotoristaNaRotaPassageiro("$2", "$3", "$4", "$5", "l.lat", "l.lng", "u.id");
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (u.id)
                u.id, u.nome, u.sexo, l.lat, l.lng, l.online_desde,
                h.placa, h.tag, h.foto_carro_url, h.foto_carro_em, h.selfie_url, h.selfie_em,
                ca.id AS carona_id, ca.origem_texto, ca.destino_texto,
                ca.origem_lat, ca.origem_lng, ca.destino_lat, ca.destino_lng, ca.vagas AS carona_vagas,
                ${distOrigem} AS dist_km
         FROM localizacoes_online l
         JOIN usuarios u ON u.id = l.usuario_id
         JOIN habilitacoes_motorista h
           ON h.motorista_id = u.id AND h.status = 'ativa' AND ${sqlSelfieValida("h")}
         LEFT JOIN LATERAL (
           SELECT id, origem_texto, destino_texto, origem_lat, origem_lng, destino_lat, destino_lng, vagas
           FROM caronas WHERE motorista_id = u.id AND status = 'ativa'
           ORDER BY created_at DESC LIMIT 1
         ) ca ON TRUE
         WHERE l.disponivel = TRUE
           AND COALESCE(u.ativo, TRUE) = TRUE
           AND ${SQL_GPS_FRESH.replace("atualizado_em", "l.atualizado_em")}
           AND u.id <> $1
           AND u.projeto_id = $6
           AND (ca.vagas IS NULL OR ca.vagas > 0)
           AND ${naPista}
         ORDER BY u.id, h.created_at DESC
       ) s
       ORDER BY dist_km ASC
       LIMIT 100`,
      [req.user.id, origem_lat, origem_lng, destino_lat, destino_lng, pid]
    );
    res.json(rows.map((r, i) => ({ ...motoristaVisivelPassageiro(r), ordem: i })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar motoristas na rota" });
  }
});


module.exports = {
  motoristaVisivelPassageiro,
};
