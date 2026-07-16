// Habilitação diária do motorista (selfie + carro + placa).
require("dotenv").config();
const app = require("../app");
const { pool } = require("../db");
const { verificarAuth } = require("../auth");
const { buscarSelfieRecente, sqlSelfieValida } = require("../usuarios");

/* ====================== HABILITAÇÃO MOTORISTA ====================== */
app.get("/api/habilitacao/hoje", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM habilitacoes_motorista
       WHERE motorista_id = $1 AND status = 'ativa'
         AND ${sqlSelfieValida("")}
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao verificar habilitação" });
  }
});

app.post("/api/habilitacao", verificarAuth, async (req, res) => {
  const {
    placa, tag, reutilizar_selfie, troca_veiculo,
    foto_carro_url, foto_carro_lat, foto_carro_lng, foto_carro_em,
    selfie_url, selfie_lat, selfie_lng, selfie_em,
  } = req.body;

  if (!placa) return res.status(400).json({ error: "Placa é obrigatória" });
  if (!foto_carro_url) return res.status(400).json({ error: "Foto do carro é obrigatória" });

  let selfieFinal = {
    url: selfie_url || null,
    lat: selfie_lat || null,
    lng: selfie_lng || null,
    em: selfie_em || null,
  };

  if (!selfieFinal.url && (reutilizar_selfie || troca_veiculo)) {
    const recent = await buscarSelfieRecente(req.user.id);
    if (!recent) {
      return res.status(400).json({ error: "Selfie expirada ou inexistente. Tire uma nova selfie (válida por 12h)." });
    }
    selfieFinal = {
      url: recent.selfie_url,
      lat: recent.selfie_lat,
      lng: recent.selfie_lng,
      em: recent.selfie_em,
    };
  }
  if (!selfieFinal.url) return res.status(400).json({ error: "Selfie é obrigatória" });

  try {
    // Encerra habilitações ativas anteriores (troca de carro / nova ativação)
    await pool.query(
      `UPDATE habilitacoes_motorista SET status = 'encerrada'
       WHERE motorista_id = $1 AND status = 'ativa'`,
      [req.user.id]
    );

    const { rows } = await pool.query(
      `INSERT INTO habilitacoes_motorista
         (motorista_id, placa, tag,
          foto_carro_url, foto_carro_lat, foto_carro_lng, foto_carro_em,
          selfie_url, selfie_lat, selfie_lng, selfie_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        req.user.id, placa.toUpperCase().trim(), tag || null,
        foto_carro_url, foto_carro_lat || null, foto_carro_lng || null, foto_carro_em || new Date(),
        selfieFinal.url, selfieFinal.lat || null, selfieFinal.lng || null, selfieFinal.em || new Date(),
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao registrar habilitação" });
  }
});

