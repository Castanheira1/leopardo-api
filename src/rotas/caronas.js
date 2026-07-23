// Publicação/listagem/cancelamento de caronas e ajuste de raio ao vivo.
require("dotenv").config();
const app = require("../app");
const { pool } = require("../db");
const { verificarAuth } = require("../auth");
const { exigirProjeto, habilitacaoAtiva, projetoDoUsuario, registrarEventoUso } = require("../usuarios");
const { horarioValido } = require("../datas");
const { calcularRotaCarona, codigoDoProjeto } = require("../geo");
const { listarCaronasParaPassageiro } = require("../services/listagem-caronas");

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

    const { rows: canceladas } = await pool.query(
      `UPDATE caronas SET status = 'cancelada' WHERE motorista_id = $1 AND status = 'ativa'
       RETURNING id`,
      [req.user.id]
    );
    if (canceladas.length) {
      await pool.query(
        `UPDATE propostas SET status = 'recusado'
         WHERE carona_id = ANY($1::int[]) AND status = 'pendente'`,
        [canceladas.map((c) => c.id)]
      );
    }

    // Caminho na malha do projeto (troncos/vias) — gravado na carona pro match.
    const cod = await codigoDoProjeto(pid);
    const rota = calcularRotaCarona(
      { lat: +origem_lat, lng: +origem_lng, nome: origem_texto || null },
      { lat: +destino_lat, lng: +destino_lng, nome: destino_texto || null },
      cod
    );
    const rotaPontos = JSON.stringify(rota.pontos || []);
    const rotaKm = Number.isFinite(rota.km) ? Math.round(rota.km * 1000) / 1000 : null;

    const { rows } = await pool.query(
      `INSERT INTO caronas
         (motorista_id, habilitacao_id, origem_texto, origem_lat, origem_lng,
          destino_texto, destino_lat, destino_lng, horario, vagas, observacao, raio_km,
          rota_pontos, rota_km)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
       RETURNING *`,
      [
        req.user.id, hab.id, origem_texto || null, origem_lat, origem_lng,
        destino_texto || null, destino_lat, destino_lng,
        horarioValido(horario), vagas || 1, observacao || null, nraio,
        rotaPontos, rotaKm,
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

    const caronas = await listarCaronasParaPassageiro({
      pid,
      lat: req.query.lat,
      lng: req.query.lng,
      dest_lat: req.query.dest_lat,
      dest_lng: req.query.dest_lng,
    });
    res.json(caronas);
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

