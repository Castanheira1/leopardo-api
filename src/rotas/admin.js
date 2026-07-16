// Painel admin: contexto, overview, métricas, contrato e anúncios da tela de espera.
require("dotenv").config();
const app = require("../app");
const { pool } = require("../db");
const { apagarFotoStorage, supabaseConfigurado, upload, uploadToSupabase } = require("../storage");
const { carregarAdminEscopo, verificarAuth } = require("../auth");
const { projetoDoUsuario } = require("../usuarios");
const { periodoFromQuery } = require("../datas");
const { sqlViagemKmValido, sqlViagemNoPeriodo } = require("../km");

/* ============================ ADMIN ============================ */
app.get("/api/admin/context", verificarAuth, carregarAdminEscopo, async (req, res) => {
  res.json({
    projeto_id: req.adminEscopo.admin_projeto_id,
    projeto_nome: req.adminEscopo.projeto_nome,
    projeto_codigo: req.adminEscopo.projeto_codigo,
    valor_contrato_mensal: Number(req.adminEscopo.valor_contrato_mensal) || 0,
  });
});

app.get("/api/admin/overview", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const pid = req.adminEscopo.admin_projeto_id;
  try {
    const [u, c, p, vEm, vCon] = await Promise.all([
      pool.query(
        "SELECT COUNT(*) FROM usuarios WHERE projeto_id = $1 AND COALESCE(ativo, TRUE) AND is_admin = FALSE",
        [pid]
      ),
      pool.query(
        `SELECT COUNT(*) FROM caronas c JOIN usuarios u ON c.motorista_id = u.id
         WHERE c.status = 'ativa' AND u.projeto_id = $1`,
        [pid]
      ),
      pool.query(
        `SELECT COUNT(*) FROM pedidos p JOIN usuarios u ON p.passageiro_id = u.id
         WHERE p.status = 'aberto' AND u.projeto_id = $1`,
        [pid]
      ),
      pool.query(
        `SELECT COUNT(*) FROM viagens v JOIN usuarios m ON v.motorista_id = m.id
         WHERE v.status = 'em_andamento' AND m.projeto_id = $1`,
        [pid]
      ),
      pool.query(
        `SELECT COUNT(*) FROM viagens v JOIN usuarios m ON v.motorista_id = m.id
         WHERE v.status = 'concluida' AND ${sqlViagemKmValido("v")} AND m.projeto_id = $1`,
        [pid]
      ),
    ]);
    const viagens = (await pool.query(
      `SELECT v.id, v.status, v.distancia_km, v.deslocamento_valido, v.iniciada_em,
              m.nome AS motorista_nome, pa.nome AS passageiro_nome
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       WHERE m.projeto_id = $1
       ORDER BY v.created_at DESC LIMIT 50`,
      [pid]
    )).rows;

    res.json({
      projeto_nome: req.adminEscopo.projeto_nome,
      projeto_codigo: req.adminEscopo.projeto_codigo,
      totalUsuarios: +u.rows[0].count,
      caronasAtivas: +c.rows[0].count,
      pedidosAbertos: +p.rows[0].count,
      viagensEmAndamento: +vEm.rows[0].count,
      viagensConcluidas: +vCon.rows[0].count,
      viagens,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao carregar painel" });
  }
});

app.get("/api/admin/metricas", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const periodo = periodoFromQuery(req.query.de, req.query.ate);
  if (!periodo) return res.status(400).json({ error: "Período inválido" });
  const pid = req.adminEscopo.admin_projeto_id;
  try {
    const [agg, ativos] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) AS viagens,
           COALESCE(SUM(v.distancia_km), 0) AS total_km,
           COUNT(*) FILTER (WHERE pa.sexo = 'F') AS mulheres_transportadas,
           COUNT(*) FILTER (WHERE pa.sexo = 'M') AS homens_transportados
         FROM viagens v
         JOIN usuarios m ON v.motorista_id = m.id
         JOIN usuarios pa ON v.passageiro_id = pa.id
         WHERE m.projeto_id = $1
           AND v.status = 'concluida'
           AND ${sqlViagemKmValido("v")}
           AND ${sqlViagemNoPeriodo("v")}`,
        [pid, periodo.de, periodo.ate]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT sub.uid) AS usuarios_ativos
         FROM (
           SELECT v.motorista_id AS uid FROM viagens v
           JOIN usuarios m ON v.motorista_id = m.id
           WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemKmValido("v")}
             AND ${sqlViagemNoPeriodo("v")}
           UNION
           SELECT v.passageiro_id FROM viagens v
           JOIN usuarios m ON v.motorista_id = m.id
           WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemKmValido("v")}
             AND ${sqlViagemNoPeriodo("v")}
         ) sub`,
        [pid, periodo.de, periodo.ate]
      ),
    ]);
    const r = agg.rows[0];
    res.json({
      periodo: { de: periodo.de, ate: periodo.ate },
      usuarios_ativos: +ativos.rows[0].usuarios_ativos,
      viagens: +r.viagens,
      total_km: Math.round(Number(r.total_km) * 100) / 100,
      mulheres_transportadas: +r.mulheres_transportadas,
      homens_transportados: +r.homens_transportados,
      valor_contrato_mensal: Number(req.adminEscopo.valor_contrato_mensal) || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao carregar métricas" });
  }
});

app.patch("/api/admin/projeto/contrato", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const valor = Number(req.body.valor_contrato_mensal);
  if (!Number.isFinite(valor) || valor < 0) {
    return res.status(400).json({ error: "Valor de contrato inválido" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE projetos SET valor_contrato_mensal = $1 WHERE id = $2 RETURNING nome, codigo, valor_contrato_mensal`,
      [valor, req.adminEscopo.admin_projeto_id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao salvar contrato" });
  }
});

/* ====================== ANÚNCIOS (vitrine na tela de espera) ====================== */
// Converte "YYYY-MM-DD" (input date do admin) em TIMESTAMPTZ no fuso de São Paulo.
// inicio = 00:00 do dia; fim = 23:59:59.999 do dia (inclusivo).
function anuncioLimiteDia(ymd, fimDoDia) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ""))) return null;
  return `${ymd}T${fimDoDia ? "23:59:59.999" : "00:00:00.000"}-03:00`;
}

// Admin: lista todos os anúncios do seu projeto (inclui agendados e expirados).
app.get("/api/admin/anuncios", verificarAuth, carregarAdminEscopo, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, titulo, imagem_url, inicio, fim, ativo, ordem, created_at
       FROM anuncios WHERE projeto_id = $1
       ORDER BY ordem ASC, inicio DESC, id DESC`,
      [req.adminEscopo.admin_projeto_id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar anúncios" });
  }
});

// Admin: cria um anúncio (imagem + janela de exibição).
app.post("/api/admin/anuncios", verificarAuth, carregarAdminEscopo, upload.single("imagem"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Imagem é obrigatória" });
  if (!supabaseConfigurado) return res.status(503).json({ error: "Storage não configurado" });
  const inicio = anuncioLimiteDia(req.body.inicio, false);
  const fim = anuncioLimiteDia(req.body.fim, true);
  if (!inicio || !fim) return res.status(400).json({ error: "Datas de início e fim são obrigatórias (AAAA-MM-DD)" });
  if (new Date(fim) < new Date(inicio)) return res.status(400).json({ error: "A data fim não pode ser anterior ao início" });
  const titulo = (req.body.titulo || "").trim().slice(0, 160) || null;
  const ordem = Number.isFinite(Number(req.body.ordem)) ? parseInt(req.body.ordem, 10) : 0;
  try {
    const url = await uploadToSupabase(req.file, "anuncios");
    if (!url) return res.status(500).json({ error: "Falha ao salvar a imagem" });
    const { rows } = await pool.query(
      `INSERT INTO anuncios (projeto_id, titulo, imagem_url, inicio, fim, ordem, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, titulo, imagem_url, inicio, fim, ativo, ordem, created_at`,
      [req.adminEscopo.admin_projeto_id, titulo, url, inicio, fim, ordem, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao criar anúncio" });
  }
});

// Admin: edita janela/ativo/ordem/título de um anúncio do seu projeto.
app.patch("/api/admin/anuncios/:id", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "ID inválido" });
  const campos = [];
  const vals = [];
  const add = (col, val) => { vals.push(val); campos.push(`${col} = $${vals.length}`); };
  if (req.body.inicio !== undefined) {
    const inicio = anuncioLimiteDia(req.body.inicio, false);
    if (!inicio) return res.status(400).json({ error: "Data de início inválida" });
    add("inicio", inicio);
  }
  if (req.body.fim !== undefined) {
    const fim = anuncioLimiteDia(req.body.fim, true);
    if (!fim) return res.status(400).json({ error: "Data de fim inválida" });
    add("fim", fim);
  }
  if (req.body.ativo !== undefined) add("ativo", Boolean(req.body.ativo));
  if (req.body.ordem !== undefined && Number.isFinite(Number(req.body.ordem))) add("ordem", parseInt(req.body.ordem, 10));
  if (req.body.titulo !== undefined) add("titulo", (req.body.titulo || "").trim().slice(0, 160) || null);
  if (!campos.length) return res.status(400).json({ error: "Nada para atualizar" });
  vals.push(id, req.adminEscopo.admin_projeto_id);
  try {
    const { rows } = await pool.query(
      `UPDATE anuncios SET ${campos.join(", ")}
       WHERE id = $${vals.length - 1} AND projeto_id = $${vals.length}
       RETURNING id, titulo, imagem_url, inicio, fim, ativo, ordem, created_at`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: "Anúncio não encontrado" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar anúncio" });
  }
});

// Admin: remove o anúncio e apaga a imagem do Storage.
app.delete("/api/admin/anuncios/:id", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "ID inválido" });
  try {
    const { rows } = await pool.query(
      `DELETE FROM anuncios WHERE id = $1 AND projeto_id = $2 RETURNING imagem_url`,
      [id, req.adminEscopo.admin_projeto_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Anúncio não encontrado" });
    await apagarFotoStorage(rows[0].imagem_url);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao remover anúncio" });
  }
});

// Passageiro: anúncios do SEU projeto que estão no ar agora (janela ativa).
app.get("/api/anuncios", verificarAuth, async (req, res) => {
  try {
    const projetoId = await projetoDoUsuario(req.user.id);
    if (!projetoId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, titulo, imagem_url
       FROM anuncios
       WHERE projeto_id = $1 AND ativo = TRUE AND inicio <= NOW() AND fim >= NOW()
       ORDER BY ordem ASC, inicio DESC, id DESC`,
      [projetoId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao carregar anúncios" });
  }
});


module.exports = {
  anuncioLimiteDia,
};
