// Sessão única por conta (JWT + sessao_id), middlewares de auth/admin e rate-limit de credenciais.
require("dotenv").config();
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("./config");
const { pool } = require("./db");

// Anti-força-bruta nas rotas de credencial (login/cadastro/recuperação): limite
// bem mais apertado que o global. Como a senha é curta (6 dígitos), travar
// tentativas por IP é essencial. Configure com AUTH_RATE_MAX (padrão 20/15min).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas. Aguarde alguns minutos e tente de novo." },
});


function gerarSessaoId() {
  return crypto.randomBytes(24).toString("hex");
}

/** Emite JWT e invalida sessão anterior da mesma conta (1 dispositivo por vez). */
async function emitirTokenSessao(user) {
  const sessao_id = gerarSessaoId();
  await pool.query("UPDATE usuarios SET sessao_id = $1 WHERE id = $2", [sessao_id, user.id]);
  return jwt.sign(
    {
      id: user.id,
      matricula: user.matricula,
      is_admin: user.is_admin,
      projeto_id: user.projeto_id,
      admin_projeto_id: user.admin_projeto_id,
      sid: sessao_id,
    },
    JWT_SECRET,
    { expiresIn: "8h" }
  );
}

const verificarAuth = async (req, res, next) => {
  const auth = req.headers.authorization || "";
  const tokenHeader = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const token = tokenHeader || req.query.token;
  if (!token) return res.status(401).json({ error: "Token não fornecido" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Sessão única: se a conta entrou noutro aparelho, este token deixa de valer.
    const { rows } = await pool.query(
      "SELECT sessao_id FROM usuarios WHERE id = $1 AND COALESCE(ativo, TRUE) = TRUE",
      [payload.id]
    );
    if (!rows.length) return res.status(401).json({ error: "Token inválido" });
    if (!payload.sid || !rows[0].sessao_id || payload.sid !== rows[0].sessao_id) {
      return res.status(401).json({
        error: "Sessão encerrada: esta conta entrou em outro dispositivo.",
      });
    }
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
};

const verificarAdmin = (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: "Apenas administradores" });
  next();
};

// Carrega o projeto do admin (ex.: S11D) — todas as rotas comerciais usam este escopo.
const carregarAdminEscopo = async (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: "Apenas administradores" });
  try {
    const { rows } = await pool.query(
      `SELECT u.admin_projeto_id, p.nome AS projeto_nome, p.codigo AS projeto_codigo,
              COALESCE(p.valor_contrato_mensal, 0) AS valor_contrato_mensal
       FROM usuarios u
       LEFT JOIN projetos p ON p.id = u.admin_projeto_id
       WHERE u.id = $1 AND u.is_admin = TRUE AND COALESCE(u.ativo, TRUE) = TRUE`,
      [req.user.id]
    );
    if (!rows.length) return res.status(403).json({ error: "Administrador inválido ou inativo" });
    if (!rows[0].admin_projeto_id) {
      return res.status(403).json({ error: "Admin sem projeto vinculado (admin_projeto_id)" });
    }
    req.adminEscopo = rows[0];
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao carregar escopo do projeto" });
  }
};


module.exports = {
  authLimiter,
  gerarSessaoId,
  emitirTokenSessao,
  verificarAuth,
  verificarAdmin,
  carregarAdminEscopo,
};
