// Helpers de usuário: projeto (com cache 60s), selfie, habilitação ativa, shape do front e validações.
require("dotenv").config();
const { HAB_SELFIE_HORAS, SQL_GPS_FRESH } = require("./config");
const { pool } = require("./db");

/** Última selfie de validação do passageiro (pedido / proposta). */
async function selfieRecentePassageiro(passageiroId) {
  if (!passageiroId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT selfie_url FROM (
         SELECT selfie_url, created_at FROM pedidos
         WHERE passageiro_id = $1 AND selfie_url IS NOT NULL AND selfie_url <> ''
         UNION ALL
         SELECT selfie_url, created_at FROM propostas
         WHERE de_usuario_id = $1 AND selfie_url IS NOT NULL AND selfie_url <> ''
       ) s
       ORDER BY created_at DESC
       LIMIT 1`,
      [passageiroId]
    );
    return rows[0]?.selfie_url || null;
  } catch (_) {
    return null;
  }
}

async function registrarEventoUso(usuarioId, evento, detalhes) {
  try {
    await pool.query(
      "INSERT INTO eventos_uso (usuario_id, evento, detalhes) VALUES ($1, $2, $3)",
      [usuarioId, evento, detalhes ? JSON.stringify(detalhes) : null]
    );
  } catch (e) {
    console.warn("registrarEventoUso:", e.message);
  }
}


const SENHA_REGEX = /^\d{6}$/;
function validarSenha6Digitos(senha) {
  return SENHA_REGEX.test(String(senha || ""));
}


function sqlSelfieValida(alias = "") {
  const p = alias ? `${alias}.` : "";
  return `COALESCE(${p}selfie_em, ${p}created_at) > NOW() - INTERVAL '${HAB_SELFIE_HORAS} hours'`;
}

async function buscarSelfieRecente(userId) {
  const { rows } = await pool.query(
    `SELECT selfie_url, selfie_lat, selfie_lng, selfie_em
     FROM habilitacoes_motorista
     WHERE motorista_id = $1 AND selfie_url IS NOT NULL
       AND ${sqlSelfieValida("")}
     ORDER BY COALESCE(selfie_em, created_at) DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function resolverProjetoId(projeto_id, projeto_codigo) {
  if (projeto_codigo) {
    // O banco é a fonte da verdade (projetos criados pelo painel valem na hora);
    // a consulta abaixo já rejeita código inexistente ou projeto inativo.
    const cod = String(projeto_codigo).trim().toUpperCase();
    const { rows } = await pool.query(
      "SELECT id FROM projetos WHERE codigo = $1 AND COALESCE(ativo, TRUE) = TRUE",
      [cod]
    );
    return rows[0]?.id || null;
  }
  const pid = projeto_id ? parseInt(projeto_id, 10) : null;
  return pid || null;
}


async function motoristaGpsVivo(motoristaId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM localizacoes_online
     WHERE usuario_id = $1 AND disponivel = TRUE
       AND ${SQL_GPS_FRESH}`,
    [motoristaId]
  );
  return rows.length > 0;
}


// Viagens cujo motorista pertence ao projeto do admin.
function filtroProjetoMotorista(projetoId, alias = "m") {
  return { sql: `${alias}.projeto_id = $1`, params: [projetoId] };
}

// Projeto do usuário: cache em memória (TTL 60 s) — endpoints quentes (mapa,
// polling 2–3 s) não precisam bater no banco a cada tick.
const _projetoCache = new Map();   // userId -> { pid, exp }
const PROJETO_CACHE_MS = 60000;

function invalidarProjetoCache(userId) {
  if (userId != null) _projetoCache.delete(Number(userId));
  else _projetoCache.clear();
}

async function projetoDoUsuario(userId) {
  const key = Number(userId);
  const hit = _projetoCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.pid;
  const { rows } = await pool.query(
    "SELECT projeto_id FROM usuarios WHERE id = $1 AND COALESCE(ativo, TRUE) = TRUE",
    [userId]
  );
  const pid = rows[0]?.projeto_id ?? null;
  _projetoCache.set(key, { pid, exp: Date.now() + PROJETO_CACHE_MS });
  return pid;
}

const SQL_USUARIO_FRONT = `
  SELECT u.id, u.nome, u.funcao, u.matricula, u.telefone, u.email, u.is_admin, u.sexo,
         u.empresa_nome, u.centro_custo, u.projeto_id, u.admin_projeto_id,
         u.politica_aceita_em,
         p.nome AS projeto_nome, p.codigo AS projeto_codigo
  FROM usuarios u
  LEFT JOIN projetos p ON p.id = u.projeto_id`;

// Espelha SUPER_ADMIN_MATRICULAS do auth (sem import circular).
const SUPER_ADMIN_MATRICULAS_FRONT = String(process.env.SUPER_ADMIN_MATRICULAS || "000000,900000")
  .split(",").map((s) => s.trim()).filter(Boolean);

function usuarioParaFront(row) {
  if (!row) return null;
  const isAdmin = !!row.is_admin;
  const superAdmin = isAdmin && SUPER_ADMIN_MATRICULAS_FRONT.includes(String(row.matricula));
  return {
    id: row.id,
    nome: row.nome,
    funcao: row.funcao || null,
    matricula: row.matricula,
    telefone: row.telefone,
    email: row.email || null,
    is_admin: isAdmin,
    // Dono da empresa: visão multi-projeto (dono.html).
    super_admin: superAdmin,
    sexo: row.sexo || null,
    empresa_nome: row.empresa_nome || null,
    centro_custo: row.centro_custo || null,
    projeto_id: row.projeto_id || null,
    projeto_nome: row.projeto_nome || null,
    projeto_codigo: row.projeto_codigo || null,
    admin_projeto_id: row.admin_projeto_id || null,
    // LGPD: usuários cadastrados antes do consentimento têm politica_aceita_em NULL.
    // O front usa isto para exibir o portão de consentimento no próximo acesso.
    politica_pendente: !row.politica_aceita_em,
  };
}

async function buscarUsuarioFront(userId) {
  const { rows } = await pool.query(`${SQL_USUARIO_FRONT} WHERE u.id = $1`, [userId]);
  return usuarioParaFront(rows[0]);
}

async function exigirProjeto(userId, res) {
  const pid = await projetoDoUsuario(userId);
  if (!pid) {
    res.status(403).json({ error: "Cadastro incompleto: projeto não vinculado. Atualize seu cadastro." });
    return null;
  }
  return pid;
}

async function validarMesmoProjeto(userIdA, userIdB, res) {
  const [pidA, pidB] = await Promise.all([projetoDoUsuario(userIdA), projetoDoUsuario(userIdB)]);
  if (!pidA || !pidB || pidA !== pidB) {
    res.status(403).json({ error: "Ação permitida apenas entre usuários do mesmo projeto." });
    return false;
  }
  return true;
}


const habilitacaoAtiva = async (userId) => {
  const { rows } = await pool.query(
    `SELECT * FROM habilitacoes_motorista
     WHERE motorista_id = $1 AND status = 'ativa'
       AND ${sqlSelfieValida("")}
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
};


module.exports = {
  selfieRecentePassageiro,
  registrarEventoUso,
  SENHA_REGEX,
  validarSenha6Digitos,
  sqlSelfieValida,
  buscarSelfieRecente,
  resolverProjetoId,
  motoristaGpsVivo,
  filtroProjetoMotorista,
  _projetoCache,
  PROJETO_CACHE_MS,
  invalidarProjetoCache,
  projetoDoUsuario,
  SQL_USUARIO_FRONT,
  usuarioParaFront,
  buscarUsuarioFront,
  exigirProjeto,
  validarMesmoProjeto,
  habilitacaoAtiva,
};
