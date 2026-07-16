// Publicação/listagem/cancelamento de caronas e ajuste de raio ao vivo.
require("dotenv").config();
const app = require("../app");
const { RAIO_MESMO_DEST_KM, RAIO_ROTA_KM, RAIO_VISIVEL_KM, SQL_GPS_FRESH } = require("../config");
const { pool } = require("../db");
const { verificarAuth } = require("../auth");
const { exigirProjeto, habilitacaoAtiva, projetoDoUsuario, registrarEventoUso } = require("../usuarios");
const { horarioValido } = require("../datas");
const { codigoDoProjeto, corredorSegmentoKm, haversine, haversineKmCoord, locaisDoProjetoCodigo, melhorPontoDeEncaixe, sqlCorredorSegmento, sqlDestinoProximoCarona } = require("../geo");

/* ============================ CARONAS ============================ */
app.post("/api/caronas", verificarAuth, async (req, res) => {
  const {
    origem_texto, origem_lat, origem_lng,
    destino_texto, destino_lat, destino_lng,
    horario, vagas, observacao, raio_km,
  } = req.body;

  if (origem_lat == null || origem_lng == null || destino_lat == null || destino_lng == null) {
    return res.status(400).json({ error: "Origem e destino são obrigatórios" });
  }
  // Alcance da barra (1–25 km); default 10 se não vier.
  const nraio = Math.min(25, Math.max(1, Number(raio_km) || 10));

  try {
    const pid = await exigirProjeto(req.user.id, res);
    if (!pid) return;

    const hab = await habilitacaoAtiva(req.user.id);
    if (!hab) return res.status(403).json({ error: "Ative o modo motorista (foto do carro + selfie) antes de oferecer carona" });

    await pool.query(
      "UPDATE caronas SET status = 'cancelada' WHERE motorista_id = $1 AND status = 'ativa'",
      [req.user.id]
    );

    const { rows } = await pool.query(
      `INSERT INTO caronas
         (motorista_id, habilitacao_id, origem_texto, origem_lat, origem_lng,
          destino_texto, destino_lat, destino_lng, horario, vagas, observacao, raio_km)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        req.user.id, hab.id, origem_texto || null, origem_lat, origem_lng,
        destino_texto || null, destino_lat, destino_lng,
        horarioValido(horario), vagas || 1, observacao || null, nraio,
      ]
    );
    const nvagas = Math.min(6, Math.max(parseInt(vagas, 10) || 1, 1));
    await pool.query(
      `INSERT INTO localizacoes_online (usuario_id, lat, lng, disponivel, online_desde, atualizado_em, vagas)
       VALUES ($1, $2, $3, TRUE, NULL, NOW(), $4)
       ON CONFLICT (usuario_id)
       DO UPDATE SET lat = $2, lng = $3, disponivel = TRUE, online_desde = NULL, atualizado_em = NOW(), vagas = $4`,
      [req.user.id, origem_lat, origem_lng, nvagas]
    );
    await registrarEventoUso(req.user.id, "motorista_modo_destino", {
      vagas: nvagas, destino: destino_texto || null, carona_id: rows[0].id,
    });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao oferecer carona" });
  }
});

// Ajuste ao vivo do alcance (barra 1–25 km) da carona ativa — sem recriar a
// carona (evita cancelar/reinserir e perder propostas). Aplica no raio de
// visibilidade e de notificação.
app.post("/api/caronas/raio", verificarAuth, async (req, res) => {
  const nraio = Math.min(25, Math.max(1, Number(req.body?.raio_km) || 10));
  try {
    await pool.query(
      "UPDATE caronas SET raio_km = $2 WHERE motorista_id = $1 AND status = 'ativa'",
      [req.user.id, nraio]
    );
    res.json({ ok: true, raio_km: nraio });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao ajustar alcance" });
  }
});

// Lista caronas ativas; se ?lat&lng informados, calcula distância da origem
app.get("/api/caronas", verificarAuth, async (req, res) => {
  const { lat, lng, dest_lat, dest_lng, meus } = req.query;
  try {
    // "meus": caronas ativas que o próprio motorista publicou (para retomar o
    // trajeto ao reabrir o app).
    if (meus) {
      const { rows } = await pool.query(
        `SELECT c.*, u.nome AS motorista_nome, h.placa, h.tag, h.foto_carro_url
         FROM caronas c
         JOIN usuarios u ON c.motorista_id = u.id
         LEFT JOIN habilitacoes_motorista h ON c.habilitacao_id = h.id
         WHERE c.status = 'ativa' AND c.motorista_id = $1
         ORDER BY c.created_at DESC`,
        [req.user.id]
      );
      return res.json(rows);
    }

    const pid = await projetoDoUsuario(req.user.id);
    if (!pid) return res.json([]);

    const temPos = lat != null && lng != null;
    const temDest = dest_lat != null && dest_lng != null;
    const params = [];

    // Distância da MINHA posição até a origem do motorista (ordenação perto->longe).
    let distSel = "";
    if (temPos) {
      params.push(lat, lng);
      distSel = `, ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} AS dist_origem`;
    }

    // Modo "indo para este local": filtra caronas cujo DESTINO é ~o local escolhido
    // e que ainda têm vaga. Sem destino, mantém o comportamento antigo (raio na origem).
    let destFiltro = "", origemRaio = "", compatSel = "";
    if (temDest) {
      params.push(dest_lat, dest_lng);
      const dl = `$${params.length - 1}`, dg = `$${params.length}`;
      const corPax = sqlCorredorSegmento(dl, dg, "c.origem_lat", "c.origem_lng", "c.destino_lat", "c.destino_lng", RAIO_ROTA_KM);
      const mesmoDest = `${haversine("c.destino_lat", "c.destino_lng", dl, dg)} <= ${RAIO_MESMO_DEST_KM}`;
      const compatTotal = `(${mesmoDest} OR ${corPax.noSegmento})`;
      const compatParcial = corPax.alemDestino;
      const compatProximo = sqlDestinoProximoCarona(dl, dg, "c.origem_lat", "c.origem_lng", "c.destino_lat", "c.destino_lng");
      // Não filtra por compatibilidade aqui: caronas 'none' ainda podem virar
      // ENCAIXE por ponto em comum (calculado em JS logo abaixo, com o catálogo
      // de locais). Quem ficar 'none' sem encaixe sai da resposta.
      destFiltro = `AND c.vagas > 0`;
      compatSel = `, CASE WHEN ${compatTotal} THEN 'total' WHEN ${compatParcial} THEN 'parcial' WHEN ${compatProximo} THEN 'proximo' ELSE 'none' END AS compat_rota`;
    } else if (temPos) {
      // Alcance por carona (barra do motorista, default 10 km) em vez de fixo.
      origemRaio = `AND ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} <= COALESCE(c.raio_km, ${RAIO_VISIVEL_KM})`;
    }

    params.push(pid);
    const filtroProj = `AND u.projeto_id = $${params.length}`;
    const orderBy = temPos ? "dist_origem ASC" : "c.created_at DESC";

    const { rows } = await pool.query(
      `SELECT c.*, u.nome AS motorista_nome, u.empresa_nome AS motorista_empresa,
              h.placa, h.tag, h.foto_carro_url,
              (lo.disponivel = TRUE) AS motorista_online ${distSel}${compatSel}
       FROM caronas c
       JOIN usuarios u ON c.motorista_id = u.id
       LEFT JOIN habilitacoes_motorista h ON c.habilitacao_id = h.id
       JOIN localizacoes_online lo ON lo.usuario_id = c.motorista_id
       WHERE c.status = 'ativa' AND COALESCE(u.ativo, TRUE) = TRUE
       AND lo.disponivel = TRUE
       AND ${SQL_GPS_FRESH.replace("atualizado_em", "lo.atualizado_em")}
       AND c.id = (
         SELECT cx.id FROM caronas cx
         WHERE cx.motorista_id = c.motorista_id AND cx.status = 'ativa'
         ORDER BY cx.created_at DESC LIMIT 1
       )
       ${filtroProj}
       ${origemRaio}
       ${destFiltro}
       ORDER BY ${orderBy}`,
      params
    );
    if (!temDest) return res.json(rows);

    // Segunda chance por PONTO EM COMUM: carona que não "bate" com o destino do
    // passageiro (compat none) ainda serve se a rota dela passa por um local
    // conhecido que adianta o passageiro (todo mundo passa pela Portaria).
    const origPax = temPos ? { lat: +lat, lng: +lng } : null;
    const destPax = { lat: +dest_lat, lng: +dest_lng };
    const locais = locaisDoProjetoCodigo(await codigoDoProjeto(pid));
    const comEncaixe = [];
    for (const c of rows) {
      if (c.compat_rota !== "none") { comEncaixe.push(c); continue; }
      if (!origPax || c.origem_lat == null || c.destino_lat == null) continue;
      // Embarque viável: passageiro no corredor da carona ou dentro do alcance dela.
      const cor = corredorSegmentoKm(origPax.lat, origPax.lng, +c.origem_lat, +c.origem_lng, +c.destino_lat, +c.destino_lng);
      const noCorredor = cor.dist <= RAIO_ROTA_KM && cor.t >= -0.05 && cor.t <= 1.05;
      const distOrigemCarona = haversineKmCoord(origPax.lat, origPax.lng, +c.origem_lat, +c.origem_lng);
      if (!noCorredor && distOrigemCarona > (Number(c.raio_km) || RAIO_VISIVEL_KM)) continue;
      const enc = melhorPontoDeEncaixe(
        origPax, destPax,
        { lat: +c.origem_lat, lng: +c.origem_lng },
        { lat: +c.destino_lat, lng: +c.destino_lng },
        locais
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
    res.json(comEncaixe);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar caronas" });
  }
});

app.delete("/api/caronas/:id", verificarAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE caronas SET status = 'cancelada'
       WHERE id = $1 AND motorista_id = $2 AND status = 'ativa'`,
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Carona não encontrada" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao cancelar carona" });
  }
});

