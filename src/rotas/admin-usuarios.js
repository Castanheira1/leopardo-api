// Admin: desativar/reativar usuários, segurança, push-status, reset de senha e chamados de acesso.
require("dotenv").config();
const app = require("../app");
const { PORT } = require("../config");
const { pool } = require("../db");
const { pushConfigurado } = require("../push");
const {
  carregarAdminEscopo,
  exigirSuperAdmin,
  verificarAdmin,
  verificarAuth,
} = require("../auth");
const { invalidarProjetoCache, resolverProjetoId, sqlSelfieValida } = require("../usuarios");

app.post("/api/admin/usuarios/:matricula/desativar", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const matricula = String(req.params.matricula || "").trim();
  const motivo = String(req.body.motivo || "Desligamento").trim();
  if (!matricula || matricula.length < 6) return res.status(400).json({ error: "Matrícula inválida" });
  const pid = req.adminEscopo.admin_projeto_id;
  try {
    const { rows } = await pool.query(
      "SELECT id, matricula, is_admin FROM usuarios WHERE matricula = $1 AND projeto_id = $2",
      [matricula, pid]
    );
    const alvo = rows[0];
    if (!alvo) return res.status(404).json({ error: "Usuário não encontrado neste projeto" });
    if (alvo.is_admin) return res.status(400).json({ error: "Não é possível desativar administrador" });

    await pool.query("UPDATE usuarios SET ativo = FALSE WHERE id = $1", [alvo.id]);
    invalidarProjetoCache(alvo.id);
    await pool.query(
      `INSERT INTO matriculas_bloqueadas (matricula, motivo, bloqueada_por)
       VALUES ($1, $2, $3)
       ON CONFLICT (matricula) DO UPDATE SET motivo = EXCLUDED.motivo, bloqueada_em = NOW(), bloqueada_por = EXCLUDED.bloqueada_por`,
      [matricula, motivo, req.user.id]
    );
    await pool.query("DELETE FROM localizacoes_online WHERE usuario_id = $1", [alvo.id]);
    await pool.query("DELETE FROM push_subscriptions WHERE usuario_id = $1", [alvo.id]);
    await pool.query(
      "UPDATE caronas SET status = 'cancelada' WHERE motorista_id = $1 AND status = 'ativa'",
      [alvo.id]
    );
    await pool.query(
      "UPDATE pedidos SET status = 'cancelado' WHERE passageiro_id = $1 AND status = 'aberto'",
      [alvo.id]
    );
    res.json({ success: true, message: `Matrícula ${matricula} desativada e bloqueada.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao desativar usuário" });
  }
});

app.post("/api/admin/usuarios/:matricula/reativar", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const matricula = String(req.params.matricula || "").trim();
  if (!matricula || matricula.length < 6) return res.status(400).json({ error: "Matrícula inválida" });
  const pid = req.adminEscopo.admin_projeto_id;
  try {
    const { rows } = await pool.query(
      "SELECT id, matricula, is_admin, COALESCE(ativo, TRUE) AS ativo FROM usuarios WHERE matricula = $1 AND projeto_id = $2",
      [matricula, pid]
    );
    const alvo = rows[0];
    if (!alvo) return res.status(404).json({ error: "Usuário não encontrado neste projeto" });

    await pool.query("UPDATE usuarios SET ativo = TRUE WHERE id = $1", [alvo.id]);
    invalidarProjetoCache(alvo.id);
    await pool.query("DELETE FROM matriculas_bloqueadas WHERE matricula = $1", [matricula]);
    res.json({
      success: true,
      message: alvo.ativo
        ? `Matrícula ${matricula} desbloqueada (já estava ativa).`
        : `Matrícula ${matricula} reativada e desbloqueada.`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao reativar usuário" });
  }
});

app.get("/api/admin/seguranca", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const pid = req.adminEscopo.admin_projeto_id;
  const matricula = String(req.query.matricula || "").trim();
  const de = req.query.de ? new Date(req.query.de) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const ate = req.query.ate ? new Date(req.query.ate) : new Date();
  if (isNaN(de.getTime()) || isNaN(ate.getTime())) {
    return res.status(400).json({ error: "Datas inválidas" });
  }
  try {
    const params = [pid, de.toISOString(), ate.toISOString()];
    let filtroMat = "";
    if (matricula) {
      params.push(matricula);
      filtroMat = `AND (m.matricula = $${params.length} OR pa.matricula = $${params.length})`;
    }
    const viagens = (await pool.query(
      `SELECT v.id, v.status, v.iniciada_em, v.finalizada_em, v.distancia_km,
              m.matricula AS motorista_matricula, m.nome AS motorista_nome,
              pa.matricula AS passageiro_matricula, pa.nome AS passageiro_nome,
              h.selfie_url AS motorista_selfie, h.foto_carro_url, h.placa,
              pr.selfie_url AS proposta_selfie, pd.selfie_url AS pedido_selfie
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       LEFT JOIN habilitacoes_motorista h ON v.habilitacao_id = h.id
       LEFT JOIN propostas pr ON v.proposta_id = pr.id
       LEFT JOIN pedidos pd ON v.pedido_id = pd.id
       WHERE m.projeto_id = $1
         AND v.iniciada_em >= $2::timestamptz AND v.iniciada_em < $3::timestamptz
         ${filtroMat}
       ORDER BY v.iniciada_em DESC
       LIMIT 200`,
      params
    )).rows;

    const habParams = [pid, de.toISOString(), ate.toISOString()];
    let habFiltroMat = "";
    if (matricula) {
      habParams.push(matricula);
      habFiltroMat = `AND u.matricula = $${habParams.length}`;
    }
    const habilitacoes = (await pool.query(
      `SELECT h.id, h.created_at, h.placa, h.selfie_url, h.foto_carro_url,
              h.selfie_lat, h.selfie_lng, h.foto_carro_lat, h.foto_carro_lng,
              u.matricula, u.nome
       FROM habilitacoes_motorista h
       JOIN usuarios u ON h.motorista_id = u.id
       WHERE u.projeto_id = $1
         AND h.created_at >= $2::timestamptz AND h.created_at < $3::timestamptz
         ${habFiltroMat}
       ORDER BY h.created_at DESC
       LIMIT 100`,
      habParams
    )).rows;

    res.json({ viagens, habilitacoes, retencao_dias: 30 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao carregar registros de segurança" });
  }
});

app.get("/api/admin/push-status", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const pid = req.adminEscopo.admin_projeto_id;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (u.id) u.id, u.nome, u.matricula,
              h.created_at AS habilitado_em,
              (SELECT COUNT(*) FROM push_subscriptions ps WHERE ps.usuario_id = u.id) AS inscricoes_push,
              l.atualizado_em AS localizacao_em,
              ROUND(EXTRACT(EPOCH FROM (NOW() - l.atualizado_em)) / 60) AS localizacao_min
       FROM habilitacoes_motorista h
       JOIN usuarios u ON u.id = h.motorista_id
       LEFT JOIN localizacoes_online l ON l.usuario_id = u.id
       WHERE h.status = 'ativa' AND ${sqlSelfieValida("h")}
         AND u.projeto_id = $1 AND COALESCE(u.ativo, TRUE) = TRUE
       ORDER BY u.id, h.created_at DESC`,
      [pid]
    );
    const total = (await pool.query("SELECT COUNT(*) FROM push_subscriptions")).rows[0].count;
    res.json({ pushConfigurado, totalInscricoes: +total, motoristas: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao carregar status do push" });
  }
});

// Reset de senha pelo admin foi REMOVIDO: era herança de outro app e definia a
// senha para "123456" (padrão conhecido). O usuário que esquecer a senha usa o
// autoatendimento por email — "Esqueceu a senha?" no login → link de token →
// ele mesmo define a nova senha (rotas /api/recuperar-senha/* em auth.js).

// Solicitar acesso admin — grava chamado, notifica por email e aguarda aprovação no painel.
async function notificarChamadoAdmin(chamado) {
  const apiKey = process.env.RESEND_API_KEY;
  const destino = process.env.ADMIN_EMAIL_NOTIFICACAO;
  if (!apiKey || !destino) {
    console.warn(`chamado #${chamado.id}: email não enviado — configure RESEND_API_KEY e ADMIN_EMAIL_NOTIFICACAO no Render`);
    return;
  }
  const from = process.env.EMAIL_FROM || "VAP <onboarding@resend.dev>";
  const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;
  const projeto = chamado.projeto_codigo || chamado.projeto_nome || "—";
  const html = `
    <h2>Nova solicitação de acesso admin — VAP</h2>
    <p><strong>Nome:</strong> ${chamado.nome}</p>
    <p><strong>Matrícula:</strong> ${chamado.matricula}</p>
    <p><strong>Empresa:</strong> ${chamado.empresa_nome || "—"}</p>
    <p><strong>Projeto:</strong> ${projeto}</p>
    <p><strong>WhatsApp:</strong> ${chamado.telefone || "—"}</p>
    <p><strong>Email:</strong> ${chamado.email || "—"}</p>
    <p><strong>Justificativa:</strong><br>${(chamado.justificativa || "—").replace(/\n/g, "<br>")}</p>
    <p style="margin-top:20px"><a href="${baseUrl}/dono.html">Abrir dashboard do dono para aprovar ou recusar</a></p>
  `;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [destino],
        subject: `[VAP] Solicitação admin — ${chamado.nome} (${chamado.matricula})`,
        html,
      }),
    });
    if (!r.ok) console.warn("Resend:", await r.text());
  } catch (e) {
    console.warn("notificarChamadoAdmin:", e.message);
  }
}

app.post("/api/admin/chamados", async (req, res) => {
  const { nome, matricula, empresa_nome, projeto_id, projeto_codigo, telefone, email, justificativa } = req.body;
  if (!nome || !matricula || !telefone || !email) {
    return res.status(400).json({ error: "Nome, matrícula, telefone e email são obrigatórios" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    return res.status(400).json({ error: "Email inválido" });
  }
  try {
    const pid = await resolverProjetoId(projeto_id, projeto_codigo);
    if (!pid) return res.status(400).json({ error: "Selecione um projeto válido" });

    const pendente = await pool.query(
      "SELECT 1 FROM admin_chamados WHERE matricula = $1 AND status = 'pendente'",
      [String(matricula).trim()]
    );
    if (pendente.rows.length > 0) {
      return res.status(400).json({ error: "Já existe uma solicitação pendente para esta matrícula" });
    }

    const { rows } = await pool.query(
      `INSERT INTO admin_chamados (nome, matricula, empresa_nome, projeto_id, telefone, email, justificativa)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [nome, String(matricula).trim(), empresa_nome || null, pid, telefone, String(email).trim().toLowerCase(), justificativa || null]
    );
    const chamado = rows[0];
    const proj = (await pool.query("SELECT nome, codigo FROM projetos WHERE id = $1", [pid])).rows[0];
    await notificarChamadoAdmin({ ...chamado, projeto_nome: proj?.nome, projeto_codigo: proj?.codigo });

    const msgEmail = process.env.ADMIN_EMAIL_NOTIFICACAO
      ? "Solicitação recebida. O administrador foi notificado por email."
      : "Solicitação recebida. Aguarde contato da equipe.";
    res.json({ message: msgEmail, id: chamado.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lista chamados: só o dono (CEO / super admin) em dono.html — pedido nasce no cadastro.
app.get("/api/admin/chamados", verificarAuth, verificarAdmin, exigirSuperAdmin, async (req, res) => {
  const status = String(req.query.status || "pendente");
  try {
    const { rows } = await pool.query(
      `SELECT c.*, p.nome AS projeto_nome, p.codigo AS projeto_codigo
       FROM admin_chamados c
       LEFT JOIN projetos p ON p.id = c.projeto_id
       WHERE c.status = $1
       ORDER BY c.created_at DESC`,
      [status]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Promove matrícula a admin do projeto do chamado. Só após aprovação. */
async function promoverAdminCanteiro(c) {
  const pid = c.projeto_id;
  if (!pid) throw new Error("Chamado sem projeto");
  const bloqueada = await pool.query("SELECT 1 FROM matriculas_bloqueadas WHERE matricula = $1", [c.matricula]);
  if (bloqueada.rows.length > 0) {
    const err = new Error("Matrícula bloqueada — não é possível aprovar");
    err.status = 400;
    throw err;
  }
  // O solicitante já tem conta normal (criada por ele, com a própria senha) —
  // aprovar apenas PROMOVE a admin, mantendo a senha dele; ele já pode logar.
  // Sem conta = pediu antes de se cadastrar: não fabricamos conta com senha
  // padrão. Ele cria a conta normal e solicita admin de novo.
  const existente = (await pool.query("SELECT id FROM usuarios WHERE matricula = $1", [c.matricula])).rows[0];
  if (!existente) {
    const err = new Error("Solicitante ainda sem cadastro. Peça para criar a conta normal (com a própria senha) e solicitar admin de novo.");
    err.status = 400;
    throw err;
  }
  await pool.query(
    `UPDATE usuarios SET
       is_admin = TRUE, admin_projeto_id = $1, projeto_id = $1,
       nome = COALESCE($2, nome), empresa_nome = COALESCE($3, empresa_nome),
       telefone = COALESCE($4, telefone), email = COALESCE($5, email),
       ativo = TRUE
     WHERE id = $6`,
    [pid, c.nome, c.empresa_nome, c.telefone, c.email, existente.id]
  );
  invalidarProjetoCache(existente.id);
}

// Aprova: só o dono (CEO) em dono.html. Até aprovar, o solicitante NÃO tem is_admin.
app.post("/api/admin/chamados/:id/aprovar", verificarAuth, verificarAdmin, exigirSuperAdmin, async (req, res) => {
  const chamadoId = parseInt(req.params.id, 10);
  if (!chamadoId) return res.status(400).json({ error: "ID inválido" });

  try {
    const { rows: chamados } = await pool.query(
      "SELECT * FROM admin_chamados WHERE id = $1 AND status = 'pendente'",
      [chamadoId]
    );
    const c = chamados[0];
    if (!c) return res.status(404).json({ error: "Solicitação não encontrada ou já processada" });

    await promoverAdminCanteiro(c);
    await pool.query("UPDATE admin_chamados SET status = 'aprovado' WHERE id = $1", [chamadoId]);
    res.json({
      message: `Admin do canteiro aprovado! ${c.nome} (matrícula ${c.matricula}) já pode entrar com a própria senha.`,
    });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || "Erro ao aprovar solicitação" });
  }
});

app.post("/api/admin/chamados/:id/recusar", verificarAuth, verificarAdmin, exigirSuperAdmin, async (req, res) => {
  const chamadoId = parseInt(req.params.id, 10);
  if (!chamadoId) return res.status(400).json({ error: "ID inválido" });

  try {
    const { rows } = await pool.query(
      "SELECT * FROM admin_chamados WHERE id = $1 AND status = 'pendente'",
      [chamadoId]
    );
    const c = rows[0];
    if (!c) return res.status(404).json({ error: "Solicitação não encontrada ou já processada" });

    await pool.query("UPDATE admin_chamados SET status = 'recusado' WHERE id = $1", [chamadoId]);
    res.json({ message: "Solicitação recusada." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


module.exports = {
  notificarChamadoAdmin,
};
