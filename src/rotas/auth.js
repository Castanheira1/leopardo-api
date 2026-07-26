// Projetos (público), cadastro, login e recuperação de senha por email.
require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const app = require("../app");
const { PORT } = require("../config");
const { pool } = require("../db");
const { authLimiter, emitirTokenSessao } = require("../auth");
const { buscarUsuarioFront, resolverProjetoId, validarSenha6Digitos } = require("../usuarios");

// Lista projetos ativos (público — usado no registro)
app.get("/api/projetos", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, nome, codigo FROM projetos WHERE ativo = TRUE ORDER BY nome");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================ AUTH ============================ */
app.post("/api/register", authLimiter, async (req, res) => {
  const { nome, funcao, matricula, telefone, email, senha, empresa_nome, projeto_id, projeto_codigo, centro_custo, sexo, aceite_politica, politica_versao } = req.body;
  const sexoNorm = sexo === "M" || sexo === "F" ? sexo : null;
  const pid = await resolverProjetoId(projeto_id, projeto_codigo);
  if (!nome || !matricula || !senha || !telefone || !email || !empresa_nome || !pid) {
    return res.status(400).json({ error: "Nome, matrícula, empresa, projeto, telefone, email e senha são obrigatórios" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    return res.status(400).json({ error: "Email inválido" });
  }
  if (!validarSenha6Digitos(senha)) {
    return res.status(400).json({ error: "A senha deve ter exatamente 6 dígitos numéricos" });
  }
  // LGPD: o consentimento é obrigatório para criar a conta (uso de selfie, foto do
  // veículo e localização). Registramos o momento e a versão da política aceita.
  if (aceite_politica !== true) {
    return res.status(400).json({ error: "É necessário aceitar a Política de Privacidade para criar a conta." });
  }
  const politicaVersao = String(politica_versao || "1.0").slice(0, 20);

  try {
    const bloqueada = await pool.query("SELECT 1 FROM matriculas_bloqueadas WHERE matricula = $1", [matricula]);
    if (bloqueada.rows.length > 0) {
      return res.status(400).json({ error: "Matrícula bloqueada. Procure o administrador." });
    }

    const check = await pool.query("SELECT id FROM usuarios WHERE matricula = $1", [matricula]);
    if (check.rows.length > 0) {
      return res.status(400).json({ error: "Matrícula já cadastrada" });
    }

    const senha_hash = await bcrypt.hash(senha, 10);
    const is_admin = matricula === "000000";

    const { rows } = await pool.query(
      `INSERT INTO usuarios (nome, matricula, senha_hash, funcao, telefone, email, is_admin, empresa_nome, projeto_id, centro_custo, sexo, politica_aceita_em, politica_versao)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12)
       RETURNING id`,
      [nome, matricula, senha_hash, funcao || null, telefone, String(email).trim().toLowerCase(), is_admin,
       empresa_nome || null, pid, centro_custo || null, sexoNorm, politicaVersao]
    );

    const userFront = await buscarUsuarioFront(rows[0].id);
    const token = await emitirTokenSessao({
      id: userFront.id,
      matricula,
      is_admin,
      projeto_id: userFront.projeto_id,
      admin_projeto_id: userFront.admin_projeto_id,
    });
    res.json({ success: true, token, user: userFront });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao criar conta" });
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  const { matricula, senha } = req.body;
  if (!matricula || !senha) return res.status(400).json({ error: "Campos obrigatórios" });

  try {
    const { rows } = await pool.query(
      "SELECT * FROM usuarios WHERE matricula = $1 AND COALESCE(ativo, TRUE) = TRUE",
      [matricula]
    );
    if (rows.length === 0) return res.status(401).json({ error: "Credenciais inválidas" });

    const user = rows[0];
    const valido = await bcrypt.compare(senha, user.senha_hash);
    if (!valido) return res.status(401).json({ error: "Credenciais inválidas" });

    // Novo login invalida a sessão do outro aparelho (mesma matrícula).
    const token = await emitirTokenSessao(user);
    const userFront = await buscarUsuarioFront(user.id);
    res.json({ token, user: userFront });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// Recuperação de senha em 2 passos: solicitar (email com link) → confirmar (nova senha).
const normEmail = (v) => String(v || "").trim().toLowerCase();

function gerarTokenRecuperacao() {
  return crypto.randomBytes(32).toString("hex");
}

function hashTokenRecuperacao(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function enviarEmailRecuperacao(usuario, token) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !usuario.email) {
    console.warn(`recuperação usuário ${usuario.id}: email não enviado — configure RESEND_API_KEY`);
    return false;
  }
  const from = process.env.EMAIL_FROM || "VAP <onboarding@resend.dev>";
  const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;
  const link = `${baseUrl}/recuperar-senha.html?token=${token}`;
  const html = `
    <h2>Recuperação de senha — VAP</h2>
    <p>Olá, <strong>${usuario.nome}</strong>.</p>
    <p>Recebemos um pedido para redefinir a senha da matrícula <strong>${usuario.matricula}</strong>.</p>
    <p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#EAD298;color:#0F3D3E;text-decoration:none;border-radius:8px;font-weight:bold;">Redefinir senha</a></p>
    <p style="font-size:12px;color:#666;">O link expira em 1 hora. Se não foi você, ignore este email.</p>
    <p style="font-size:12px;color:#666;">Ou copie: ${link}</p>
  `;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [usuario.email],
        subject: "[VAP] Redefinir sua senha",
        html,
      }),
    });
    if (!r.ok) {
      console.warn("Resend recuperação:", await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.warn("enviarEmailRecuperacao:", e.message);
    return false;
  }
}

// Passo 1: usuário informa matrícula + email → envia link (se conferir).
async function solicitarRecuperacaoSenha(matricula, email) {
  const msgOk = {
    success: true,
    message: "Se os dados estiverem corretos, enviamos um link para redefinir a senha. Verifique seu email (e o spam).",
  };

  const { rows } = await pool.query(
    "SELECT id, nome, matricula, email FROM usuarios WHERE matricula = $1 AND COALESCE(ativo, TRUE) = TRUE",
    [String(matricula).trim()]
  );
  const user = rows[0];
  if (!user?.email || normEmail(user.email) !== normEmail(email)) {
    return { status: 200, body: msgOk };
  }

  await pool.query(
    "UPDATE tokens_recuperacao SET usado = TRUE WHERE usuario_id = $1 AND usado = FALSE",
    [user.id]
  );

  const token = gerarTokenRecuperacao();
  const tokenHash = hashTokenRecuperacao(token);
  await pool.query(
    `INSERT INTO tokens_recuperacao (usuario_id, token_hash, expira_em)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
    [user.id, tokenHash]
  );

  const enviado = await enviarEmailRecuperacao(user, token);
  if (!enviado && process.env.NODE_ENV === "production") {
    return { status: 503, body: { error: "Serviço de email indisponível. Procure o administrador." } };
  }
  return { status: 200, body: msgOk };
}

app.post("/api/recuperar-senha/solicitar", authLimiter, async (req, res) => {
  const { matricula, email } = req.body;
  if (!matricula || !email) {
    return res.status(400).json({ error: "Informe matrícula e email" });
  }
  try {
    const out = await solicitarRecuperacaoSenha(matricula, email);
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// Passo 2: link do email → nova senha de 6 dígitos.
app.post("/api/recuperar-senha/confirmar", authLimiter, async (req, res) => {
  const { token, nova_senha } = req.body;
  if (!token || !nova_senha) {
    return res.status(400).json({ error: "Token e nova senha são obrigatórios" });
  }
  if (!validarSenha6Digitos(nova_senha)) {
    return res.status(400).json({ error: "A nova senha deve ter exatamente 6 dígitos numéricos" });
  }

  try {
    const tokenHash = hashTokenRecuperacao(token);
    const { rows } = await pool.query(
      `SELECT t.id, t.usuario_id FROM tokens_recuperacao t
       WHERE t.token_hash = $1 AND t.usado = FALSE AND t.expira_em > NOW()`,
      [tokenHash]
    );
    if (!rows.length) {
      return res.status(400).json({ error: "Link inválido ou expirado. Solicite novamente no login." });
    }

    const senha_hash = await bcrypt.hash(String(nova_senha), 10);
    await pool.query("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [senha_hash, rows[0].usuario_id]);
    await pool.query("UPDATE tokens_recuperacao SET usado = TRUE WHERE id = $1", [rows[0].id]);

    res.json({ success: true, message: "Senha alterada! Já pode entrar com a nova senha." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// Alias legado — use /solicitar (envia email) em vez de redefinir na hora.
app.post("/api/recuperar-senha", authLimiter, async (req, res) => {
  const { matricula, email, nova_senha } = req.body;
  if (nova_senha) {
    return res.status(400).json({
      error: "Abra o link enviado por email para definir a nova senha.",
    });
  }
  if (!matricula || !email) {
    return res.status(400).json({ error: "Informe matrícula e email" });
  }
  try {
    const out = await solicitarRecuperacaoSenha(matricula, email);
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});


module.exports = {
  normEmail,
  gerarTokenRecuperacao,
  hashTokenRecuperacao,
  enviarEmailRecuperacao,
  solicitarRecuperacaoSenha,
};
