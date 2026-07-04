const express = require("express");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
const webpush = require("web-push");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "veiculos";
// Raio (km) de proximidade para considerar origem/destino "perto" (match)
const RAIO_KM = Number(process.env.RAIO_MATCH_KM || 3);
// Raio (km) de VISIBILIDADE no mapa e nos avisos: carona é coisa de gente
// próxima — mais que isso pega outra cidade e vira bagunça.
const RAIO_VISIVEL_KM = Number(process.env.RAIO_VISIVEL_KM || 10);
// Raio (km) do aviso com o APP FECHADO: motorista habilitado que está BEM
// perto (última posição do dia) é avisado por push mesmo sem app aberto e
// sem carona publicada — "estou na sala e alguém pediu aqui do lado".
const RAIO_PUSH_PERTO_KM = Number(process.env.RAIO_PUSH_PERTO_KM || 1);

if (!JWT_SECRET) {
  console.error("ERRO: JWT_SECRET não definido no .env");
  process.exit(1);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
// 1200: o polling legítimo de um motorista em viagem chega perto de 600/15min
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1200 }));

// CORS restrito. O front (PWA) é servido pela MESMA origem desta API, então não
// precisa de CORS cross-origin no uso normal. Por padrão, nenhuma origem externa
// é liberada (same-origin continua funcionando). Para liberar um app/origem
// específica, defina CORS_ORIGINS="https://a.com,https://b.com" no ambiente.
// Antes era origin:"*", que deixava qualquer site chamar a API com o token do usuário.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: CORS_ORIGINS.length ? CORS_ORIGINS : false, // false = sem CORS externo (só mesma origem)
  credentials: true,
}));

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

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,                        // não subir: o Session pooler do Supabase tem teto próprio
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // falha rápido em vez de enfileirar para sempre
});

pool.connect()
  .then((client) => { console.log("Conectado ao PostgreSQL"); client.release(); garantirColunasUsuarios(); garantirTabelaPush(); garantirColunasViagens(); garantirColunasPedidos(); garantirSchemaComercial(); garantirRlsSupabase(); })
  .catch((err) => console.log("Erro ao conectar:", err.message));

// Auto-heal: garante as colunas que o cadastro usa. Bancos antigos podem não
// tê-las porque uma ordem antiga do schema.sql falhava os ALTER com FK (os
// ALTER de projeto_id/empresa_id referenciavam tabelas ainda não criadas).
// Tudo é "ADD COLUMN IF NOT EXISTS" — no-op se a coluna já existe.
async function garantirColunasUsuarios() {
  const colunas = [
    "email VARCHAR(255)",
    "empresa_nome VARCHAR(150)",
    "centro_custo VARCHAR(100)",
    "projeto_id INTEGER",
    "admin_projeto_id INTEGER",
    "sexo VARCHAR(10)",
    "ativo BOOLEAN DEFAULT TRUE",
    "politica_aceita_em TIMESTAMP",
    "politica_versao VARCHAR(20)",
  ];
  for (const c of colunas) {
    try {
      await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ${c}`);
    } catch (e) {
      console.warn("garantirColunasUsuarios:", e.message);
    }
  }
}

// Notificações push (Web Push / VAPID). Opcional: sem as chaves, o app sobe
// normalmente e só não envia notificações (mesma filosofia do Supabase).
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const pushConfigurado = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushConfigurado) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:contato@vap.app", VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn("AVISO: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY não definidos — notificações push desativadas.");
}

// Envia uma notificação para todos os aparelhos inscritos de um usuário.
// Remove inscrições mortas (app desinstalado → 404/410). Nunca lança.
async function enviarPush(usuarioId, payload) {
  if (!pushConfigurado || !usuarioId) return;
  try {
    const { rows } = await pool.query(
      "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE usuario_id = $1",
      [usuarioId]
    );
    if (!rows.length) { console.log(`push: usuário ${usuarioId} SEM inscrição — notificação não sai`); return; }
    const data = JSON.stringify(payload);
    let falhas = 0;
    await Promise.all(rows.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data);
      } catch (err) {
        falhas++;
        console.warn(`push: falha para usuário ${usuarioId} (${err.statusCode || err.message})`);
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [s.endpoint]).catch(() => {});
        }
      }
    }));
    console.log(`push: usuário ${usuarioId} — ${rows.length} inscrição(ões), ${falhas} falha(s)`);
  } catch (err) {
    console.error("enviarPush:", err.message);
  }
}

async function garantirSchemaComercial() {
  try {
    await pool.query("ALTER TABLE projetos ADD COLUMN IF NOT EXISTS valor_contrato_mensal NUMERIC(12,2) DEFAULT 0");
    await pool.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS matriculas_bloqueadas (
        id SERIAL PRIMARY KEY,
        matricula VARCHAR(50) UNIQUE NOT NULL,
        motivo TEXT,
        bloqueada_em TIMESTAMP DEFAULT NOW(),
        bloqueada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_chamados (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        matricula VARCHAR(50) NOT NULL,
        empresa_nome VARCHAR(150),
        projeto_id INTEGER REFERENCES projetos(id),
        telefone VARCHAR(20),
        email VARCHAR(255),
        justificativa TEXT,
        status VARCHAR(20) DEFAULT 'pendente'
          CHECK (status IN ('pendente', 'aprovado', 'recusado')),
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`
      UPDATE usuarios SET admin_projeto_id = (SELECT id FROM projetos WHERE codigo = 'S11D' LIMIT 1)
      WHERE matricula = '000000' AND admin_projeto_id IS NULL`);
    await pool.query(`
      INSERT INTO projetos (nome, codigo) VALUES
        ('S11D', 'S11D'),
        ('Salobo', 'SALOBO'),
        ('Carajás', 'CARAJAS'),
        ('Sossego', 'SOSSEGO')
      ON CONFLICT (codigo) DO NOTHING`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tokens_recuperacao (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        token_hash VARCHAR(64) NOT NULL,
        expira_em TIMESTAMP NOT NULL,
        usado BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_tokens_recup_hash
      ON tokens_recuperacao(token_hash) WHERE usado = FALSE`);
  } catch (e) {
    console.warn("garantirSchemaComercial:", e.message);
  }
}

async function garantirRlsSupabase() {
  const tabelas = ["matriculas_bloqueadas", "push_subscriptions", "tokens_recuperacao"];
  for (const t of tabelas) {
    try {
      await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await pool.query(`REVOKE ALL ON ${t} FROM anon, authenticated`);
    } catch (e) {
      console.warn(`garantirRlsSupabase(${t}):`, e.message);
    }
  }
}

const SENHA_REGEX = /^\d{6}$/;
function validarSenha6Digitos(senha) {
  return SENHA_REGEX.test(String(senha || ""));
}

const CODIGOS_PROJETO = ["S11D", "SALOBO", "CARAJAS", "SOSSEGO"];
const HAB_SELFIE_HORAS = 12;

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
    const cod = String(projeto_codigo).trim().toUpperCase();
    if (!CODIGOS_PROJETO.includes(cod)) return null;
    const { rows } = await pool.query(
      "SELECT id FROM projetos WHERE codigo = $1 AND COALESCE(ativo, TRUE) = TRUE",
      [cod]
    );
    return rows[0]?.id || null;
  }
  const pid = projeto_id ? parseInt(projeto_id, 10) : null;
  return pid || null;
}

async function garantirColunasPedidos() {
  try {
    await pool.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pessoas INTEGER DEFAULT 1");
    // notificado: pedido agendado (horário futuro) só notifica os motoristas na hora
    // marcada. Marca quando a notificação de proximidade já foi enviada.
    await pool.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS notificado BOOLEAN DEFAULT FALSE");
  } catch (e) {
    console.warn("garantirColunasPedidos:", e.message);
  }
}

// Auto-heal: a viagem tem 2 fases — 'encontro' (motorista indo buscar) e
// 'destino' (a caminho do destino). Bancos antigos não têm a coluna.
async function garantirColunasViagens() {
  try {
    await pool.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS fase TEXT DEFAULT 'encontro'");
  } catch (e) {
    console.warn("garantirColunasViagens:", e.message);
  }
}

// Auto-heal: cria a tabela de inscrições de notificação se não existir (o
// schema.sql é aplicado à mão; isto garante que o push funcione sem esse passo).
async function garantirTabelaPush() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_push_usuario ON push_subscriptions(usuario_id)");
  } catch (e) {
    console.warn("garantirTabelaPush:", e.message);
  }
}

// Não derruba o boot quando o Supabase ainda não foi configurado:
// o app sobe e serve as páginas; apenas o upload de fotos fica indisponível.
const supabaseConfigurado = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
if (!supabaseConfigurado) {
  console.warn("AVISO: SUPABASE_URL/SUPABASE_KEY não definidos — upload de fotos desativado.");
}
const supabase = createClient(
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_KEY || "placeholder-key"
);

// Upload genérico para o Supabase Storage (mesmo mecanismo das fotos de carro)
const uploadToSupabase = async (file, pasta = "") => {
  if (!file) return null;
  try {
    const prefixo = pasta ? `${pasta.replace(/\/$/, "")}/` : "";
    const fileName = `${prefixo}${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ".jpg"}`;

    const { error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: false });

    if (error) {
      console.error("Erro upload Supabase:", error.message);
      return null;
    }

    const { data: urlData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(fileName);
    return urlData.publicUrl;
  } catch (err) {
    console.error("Erro upload:", err.message);
    return null;
  }
};

function pathFromPublicUrl(url) {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${SUPABASE_BUCKET}/`;
  const i = url.indexOf(marker);
  if (i === -1) return null;
  return decodeURIComponent(url.slice(i + marker.length));
}

async function apagarFotoStorage(url) {
  const p = pathFromPublicUrl(url);
  if (!p || !supabaseConfigurado) return;
  try {
    await supabase.storage.from(SUPABASE_BUCKET).remove([p]);
  } catch (e) {
    console.warn("apagarFotoStorage:", e.message);
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    ["image/jpeg", "image/png", "image/webp", "image/jpg"].includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Apenas imagens"), false),
});

const verificarAuth = (req, res, next) => {
  const auth = req.headers.authorization || "";
  const tokenHeader = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const token = tokenHeader || req.query.token;
  if (!token) return res.status(401).json({ error: "Token não fornecido" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
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

function periodoFromQuery(de, ate) {
  const fim = ate ? new Date(ate) : new Date();
  const inicio = de ? new Date(de) : new Date(fim.getFullYear(), fim.getMonth(), 1);
  if (isNaN(inicio.getTime()) || isNaN(fim.getTime())) return null;
  return { de: inicio.toISOString(), ate: fim.toISOString() };
}

// Viagens cujo motorista pertence ao projeto do admin.
function filtroProjetoMotorista(projetoId, alias = "m") {
  return { sql: `${alias}.projeto_id = $1`, params: [projetoId] };
}

async function projetoDoUsuario(userId) {
  const { rows } = await pool.query(
    "SELECT projeto_id FROM usuarios WHERE id = $1 AND COALESCE(ativo, TRUE) = TRUE",
    [userId]
  );
  return rows[0]?.projeto_id ?? null;
}

const SQL_USUARIO_FRONT = `
  SELECT u.id, u.nome, u.funcao, u.matricula, u.telefone, u.email, u.is_admin, u.sexo,
         u.empresa_nome, u.centro_custo, u.projeto_id, u.admin_projeto_id,
         u.politica_aceita_em,
         p.nome AS projeto_nome, p.codigo AS projeto_codigo
  FROM usuarios u
  LEFT JOIN projetos p ON p.id = u.projeto_id`;

function usuarioParaFront(row) {
  if (!row) return null;
  return {
    id: row.id,
    nome: row.nome,
    funcao: row.funcao || null,
    matricula: row.matricula,
    telefone: row.telefone,
    email: row.email || null,
    is_admin: !!row.is_admin,
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

async function aplicarRetencaoFotos() {
  if (!supabaseConfigurado) return;
  const limite = "NOW() - INTERVAL '30 days'";
  const fontes = [
    { tabela: "habilitacoes_motorista", data: "created_at", cols: ["selfie_url", "foto_carro_url"] },
    { tabela: "pedidos", data: "created_at", cols: ["selfie_url"] },
    { tabela: "propostas", data: "created_at", cols: ["selfie_url"] },
  ];
  for (const f of fontes) {
    for (const col of f.cols) {
      try {
        const { rows } = await pool.query(
          `SELECT id, ${col} AS url FROM ${f.tabela}
           WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${f.data} < ${limite}
           LIMIT 200`
        );
        for (const r of rows) {
          await apagarFotoStorage(r.url);
          await pool.query(`UPDATE ${f.tabela} SET ${col} = NULL WHERE id = $1`, [r.id]);
        }
        if (rows.length) console.log(`retencao: ${rows.length} foto(s) em ${f.tabela}.${col}`);
      } catch (e) {
        console.warn("aplicarRetencaoFotos:", f.tabela, e.message);
      }
    }
  }
}

// Horário vindo do cliente: só aceita data que parseia; senão vira NULL ("agora").
// Protege contra datetime-local degradado (iOS antigo) mandando texto inválido,
// que gravaria um pedido/carona invisível para sempre.
const horarioValido = (h) => (h && !isNaN(Date.parse(h)) ? h : null);

// Expressão Haversine (km) entre uma coluna (latCol/lngCol) e parâmetros $i/$j
const haversine = (latCol, lngCol, pLat, pLng) => `
  (6371 * acos(LEAST(1, GREATEST(-1,
    cos(radians(${pLat})) * cos(radians(${latCol})) * cos(radians(${lngCol}) - radians(${pLng}))
    + sin(radians(${pLat})) * sin(radians(${latCol}))
  ))))`;

// Notifica os motoristas MAIS PERTO do embarque de um pedido em duas faixas:
// - posição FRESCA (app aberto há <=10 min): até RAIO_VISIVEL_KM;
// - posição do DIA (app pode estar fechado): até RAIO_PUSH_PERTO_KM — o
//   motorista habilitado que está "na sala" a 1 km é avisado por push mesmo
//   sem app aberto e sem carona publicada.
// Marca o pedido como notificado. Usado no POST (pedido "para agora") e pelo
// agendador (pedido com horário marcado).
async function notificarMotoristasProximos(ped) {
  try {
    const passInfo = (await pool.query(
      "SELECT nome, projeto_id FROM usuarios WHERE id = $1",
      [ped.passageiro_id]
    )).rows[0];
    if (!passInfo?.projeto_id) return;

    const nome = passInfo.nome || "Um colega";
    const motoristas = (await pool.query(
      `SELECT motorista_id FROM (
         SELECT DISTINCT ON (h.motorista_id) h.motorista_id, l.atualizado_em,
                ${haversine("l.lat", "l.lng", "$1", "$2")} AS dist
         FROM habilitacoes_motorista h
         JOIN localizacoes_online l ON l.usuario_id = h.motorista_id
         JOIN usuarios um ON um.id = h.motorista_id
         WHERE h.status = 'ativa' AND ${sqlSelfieValida("h")}
           AND h.motorista_id <> $3
           AND um.projeto_id = $6
           AND COALESCE(um.ativo, TRUE) = TRUE
         ORDER BY h.motorista_id, h.created_at DESC
       ) s
       WHERE (s.atualizado_em > NOW() - INTERVAL '10 minutes' AND s.dist <= $4)
          OR s.dist <= $5
       ORDER BY s.dist ASC
       LIMIT 8`,
      [ped.origem_lat, ped.origem_lng, ped.passageiro_id, RAIO_VISIVEL_KM, RAIO_PUSH_PERTO_KM, passInfo.projeto_id]
    )).rows;
    const destino = ped.destino_texto ? ` para ${ped.destino_texto}` : " aqui perto";
    motoristas.forEach((m) => enviarPush(m.motorista_id, {
      title: "Carona perto de você",
      body: `${nome} está pedindo carona${destino}. Abra o app para oferecer.`,
      url: "/dashboard.html",
    }));
  } catch (e) { console.warn("notificarMotoristasProximos:", e.message); }
  try { await pool.query("UPDATE pedidos SET notificado = TRUE WHERE id = $1", [ped.id]); } catch (_) {}
}

// Agendador: pedidos com horário marcado só aparecem/notificam na hora. A cada
// minuto, dispara a notificação de proximidade dos que acabaram de "vencer".
setInterval(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT id, passageiro_id, origem_lat, origem_lng, destino_texto FROM pedidos
      WHERE status = 'aberto' AND notificado = FALSE
        AND horario IS NOT NULL AND horario <= NOW()
    `);
    await Promise.all(rows.map(notificarMotoristasProximos));
  } catch (err) {
    console.error("Erro ao notificar pedidos agendados:", err.message);
  }
}, 60 * 1000);

// Keep-alive: o plano FREE do Render hiberna o serviço após ~15 min sem
// tráfego — a próxima visita paga 30-60s de partida a frio e os agendadores
// param (aviso de pedido agendado, expiração). Um auto-ping a cada 10 min
// mantém tudo acordado. O Render define RENDER_EXTERNAL_URL sozinho; sem a
// env (dev local), não faz nada. Alternativa definitiva: plan starter.
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS || 10 * 60 * 1000);
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/api/config`)
      .then((r) => { if (!r.ok) console.warn("keep-alive: resposta", r.status); })
      .catch((e) => console.warn("keep-alive:", e.message));
  }, KEEPALIVE_MS);
  console.log(`Keep-alive ativo (${KEEPALIVE_MS / 1000}s) em ${process.env.RENDER_EXTERNAL_URL}`);
}

// Marca pedidos antigos como cancelados (limpeza leve): "para agora" parados há mais
// de 3h, e agendados cujo horário já passou há mais de 3h.
setInterval(async () => {
  try {
    await pool.query(`
      UPDATE pedidos SET status = 'cancelado'
      WHERE status = 'aberto' AND (
        (horario IS NULL AND created_at < NOW() - INTERVAL '3 hours')
        OR (horario IS NOT NULL AND horario < NOW() - INTERVAL '3 hours')
      )
    `);
  } catch (err) {
    console.error("Erro ao expirar pedidos:", err.message);
  }
}, 5 * 60 * 1000);

// Retenção de fotos de segurança: apaga do Storage após 30 dias.
setInterval(() => { aplicarRetencaoFotos().catch((e) => console.warn("retencao:", e.message)); }, 24 * 60 * 60 * 1000);
setTimeout(() => { aplicarRetencaoFotos().catch(() => {}); }, 60 * 1000);

/* ============================ CONFIG ============================ */
app.get("/api/config", (req, res) => {
  res.json({ mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "", pushPublicKey: VAPID_PUBLIC });
});

/* ============================ PUSH ============================ */
// Registra o aparelho do usuário para receber notificações.
app.post("/api/push/subscribe", verificarAuth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: "Inscrição inválida" });
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (usuario_id, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint)
       DO UPDATE SET usuario_id = EXCLUDED.usuario_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user.id, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("push subscribe:", err.message);
    res.status(500).json({ error: "Erro ao registrar notificações" });
  }
});

// Remove a inscrição (logout / usuário desligou as notificações).
app.post("/api/push/unsubscribe", verificarAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint obrigatório" });
  try {
    await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND usuario_id = $2", [endpoint, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao remover notificações" });
  }
});

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
    const token = jwt.sign(
      {
        id: userFront.id,
        matricula,
        is_admin,
        projeto_id: userFront.projeto_id,
        admin_projeto_id: userFront.admin_projeto_id,
      },
      JWT_SECRET,
      { expiresIn: "8h" }
    );
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

    const token = jwt.sign(
      {
        id: user.id,
        matricula: user.matricula,
        is_admin: user.is_admin,
        projeto_id: user.projeto_id,
        admin_projeto_id: user.admin_projeto_id,
      },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

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

app.get("/api/perfil", verificarAuth, async (req, res) => {
  try {
    const userFront = await buscarUsuarioFront(req.user.id);
    if (!userFront) return res.status(404).json({ error: "Usuário não encontrado" });
    res.json(userFront);
  } catch (err) {
    res.status(500).json({ error: "Erro ao carregar perfil" });
  }
});

// LGPD: aceite da Política por usuário JÁ logado (portão de consentimento para
// quem se cadastrou antes desta versão). Só grava se ainda não havia aceite, para
// preservar o carimbo original de quem já consentiu.
app.post("/api/perfil/aceitar-politica", verificarAuth, async (req, res) => {
  const versao = String(req.body?.politica_versao || "1.0").slice(0, 20);
  try {
    await pool.query(
      `UPDATE usuarios
         SET politica_aceita_em = COALESCE(politica_aceita_em, NOW()),
             politica_versao = COALESCE(politica_versao, $1)
       WHERE id = $2`,
      [versao, req.user.id]
    );
    const userFront = await buscarUsuarioFront(req.user.id);
    res.json(userFront);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao registrar o aceite" });
  }
});

app.patch("/api/perfil", verificarAuth, async (req, res) => {
  const { telefone, nome, funcao, sexo, empresa_nome, centro_custo, projeto_codigo, projeto_id, email } = req.body;
  const sexoNorm = sexo === "M" || sexo === "F" ? sexo : null;
  try {
    const atual = await buscarUsuarioFront(req.user.id);
    if (!atual) return res.status(404).json({ error: "Usuário não encontrado" });

    let pid = null;
    if (projeto_codigo || projeto_id) {
      pid = await resolverProjetoId(projeto_id, projeto_codigo);
      if (!pid) return res.status(400).json({ error: "Selecione um projeto válido" });
    }

    let emailNovo = null;
    if (email != null && String(email).trim()) {
      if (atual.email) {
        return res.status(400).json({ error: "O email não pode ser alterado pelo perfil. Use recuperação de senha no login." });
      }
      emailNovo = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNovo)) {
        return res.status(400).json({ error: "Email inválido" });
      }
      const dup = await pool.query(
        "SELECT 1 FROM usuarios WHERE email = $1 AND id <> $2",
        [emailNovo, req.user.id]
      );
      if (dup.rows.length) return res.status(409).json({ error: "Este email já está em uso" });
    }

    await pool.query(
      `UPDATE usuarios SET
         telefone = COALESCE($1, telefone),
         nome = COALESCE($2, nome),
         funcao = COALESCE($3, funcao),
         sexo = COALESCE($4, sexo),
         empresa_nome = COALESCE($5, empresa_nome),
         centro_custo = COALESCE($6, centro_custo),
         projeto_id = COALESCE($7, projeto_id),
         email = COALESCE($8, email)
       WHERE id = $9`,
      [
        telefone || null, nome || null, funcao || null, sexoNorm,
        empresa_nome || null, centro_custo ?? null, pid, emailNovo, req.user.id,
      ]
    );
    const userFront = await buscarUsuarioFront(req.user.id);
    res.json(userFront);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar perfil" });
  }
});

/* ============================ FOTOS ============================ */
// Recebe a foto capturada ao vivo pela câmera e devolve a URL pública.
// A pasta separa selfies/carros dentro do mesmo bucket.
app.post("/api/fotos", verificarAuth, upload.single("foto"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Foto é obrigatória" });
  if (req.body.origem !== "camera") {
    return res.status(400).json({ error: "Só é permitida foto capturada ao vivo pela câmera." });
  }
  const capturado = req.body.capturado_em ? new Date(req.body.capturado_em) : null;
  if (!capturado || Number.isNaN(capturado.getTime())) {
    return res.status(400).json({ error: "Carimbo de captura inválido." });
  }
  const diffMs = Date.now() - capturado.getTime();
  if (diffMs < -5000 || diffMs > 120000) {
    return res.status(400).json({ error: "Foto expirada ou inválida. Tire uma nova foto com a câmera." });
  }
  const pasta = ["selfies", "carros"].includes(req.body.tipo) ? req.body.tipo : "outros";
  const url = await uploadToSupabase(req.file, pasta);
  if (!url) return res.status(500).json({ error: "Falha ao salvar a foto" });
  res.json({ url });
});

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

/* ============================ CARONAS ============================ */
app.post("/api/caronas", verificarAuth, async (req, res) => {
  const {
    origem_texto, origem_lat, origem_lng,
    destino_texto, destino_lat, destino_lng,
    horario, vagas, observacao,
  } = req.body;

  if (origem_lat == null || origem_lng == null || destino_lat == null || destino_lng == null) {
    return res.status(400).json({ error: "Origem e destino são obrigatórios" });
  }

  try {
    const pid = await exigirProjeto(req.user.id, res);
    if (!pid) return;

    const hab = await habilitacaoAtiva(req.user.id);
    if (!hab) return res.status(403).json({ error: "Ative o modo motorista (foto do carro + selfie) antes de oferecer carona" });

    const { rows } = await pool.query(
      `INSERT INTO caronas
         (motorista_id, habilitacao_id, origem_texto, origem_lat, origem_lng,
          destino_texto, destino_lat, destino_lng, horario, vagas, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        req.user.id, hab.id, origem_texto || null, origem_lat, origem_lng,
        destino_texto || null, destino_lat, destino_lng,
        horarioValido(horario), vagas || 1, observacao || null,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao oferecer carona" });
  }
});

// Lista caronas ativas; se ?lat&lng informados, calcula distância da origem
app.get("/api/caronas", verificarAuth, async (req, res) => {
  const { lat, lng, meus } = req.query;
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

    // Com lat/lng, mostra só caronas dentro do raio de visibilidade.
    const pid = await projetoDoUsuario(req.user.id);
    if (!pid) return res.json([]);
    const dist = lat && lng ? `, ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} AS dist_origem` : "";
    const raio = lat && lng ? `AND ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} <= $3` : "";
    const params = lat && lng ? [lat, lng, RAIO_VISIVEL_KM] : [];
    if (pid) { params.push(pid); }
    const filtroProj = pid ? `AND u.projeto_id = $${params.length}` : "";
    const orderBy = lat && lng ? "dist_origem ASC" : "c.created_at DESC";

    const { rows } = await pool.query(
      `SELECT c.*, u.nome AS motorista_nome, h.placa, h.tag, h.foto_carro_url ${dist}
       FROM caronas c
       JOIN usuarios u ON c.motorista_id = u.id
       LEFT JOIN habilitacoes_motorista h ON c.habilitacao_id = h.id
       WHERE c.status = 'ativa' AND COALESCE(u.ativo, TRUE) = TRUE
       ${filtroProj}
       ${raio}
       ORDER BY ${orderBy}`,
      params
    );
    res.json(rows);
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

/* ============================ PEDIDOS ============================ */
app.post("/api/pedidos", verificarAuth, async (req, res) => {
  const {
    origem_texto, origem_lat, origem_lng,
    destino_texto, destino_lat, destino_lng,
    horario, observacao, pessoas,
    selfie_url, selfie_lat, selfie_lng, selfie_em,
  } = req.body;
  const nPessoas = Math.min(Math.max(parseInt(pessoas, 10) || 1, 1), 6);

  if (origem_lat == null || origem_lng == null || destino_lat == null || destino_lng == null) {
    return res.status(400).json({ error: "Origem e destino são obrigatórios" });
  }
  if (!selfie_url) return res.status(400).json({ error: "Selfie é obrigatória para pedir carona" });

  try {
    const pid = await exigirProjeto(req.user.id, res);
    if (!pid) return;

    // Um pedido aberto por passageiro: cancela os anteriores (evita bonequinhos
    // duplicados no mapa do motorista).
    await pool.query("UPDATE pedidos SET status = 'cancelado' WHERE passageiro_id = $1 AND status = 'aberto'", [req.user.id]);
    const { rows } = await pool.query(
      `INSERT INTO pedidos
         (passageiro_id, origem_texto, origem_lat, origem_lng,
          destino_texto, destino_lat, destino_lng, horario, observacao, pessoas,
          selfie_url, selfie_lat, selfie_lng, selfie_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        req.user.id, origem_texto || null, origem_lat, origem_lng,
        destino_texto || null, destino_lat, destino_lng, horarioValido(horario), observacao || null, nPessoas,
        selfie_url, selfie_lat || null, selfie_lng || null, selfie_em || new Date(),
      ]
    );
    res.json(rows[0]);

    // Pedido "para agora" (sem horário ou horário já vencido): notifica os motoristas
    // perto na hora. Pedido AGENDADO (horário futuro): não notifica agora — o agendador
    // dispara a notificação na hora marcada (notificado continua FALSE até lá).
    const ped = rows[0];
    const agendadoFuturo = ped.horario && new Date(ped.horario).getTime() > Date.now();
    if (!agendadoFuturo) await notificarMotoristasProximos(ped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao criar pedido" });
  }
});

app.get("/api/pedidos", verificarAuth, async (req, res) => {
  const { lat, lng, meus } = req.query;
  try {
    // "meus": pedidos abertos do próprio passageiro (ficam esperando até casar ou
    // serem cancelados). Inclui quantas ofertas de motorista já chegaram.
    if (meus) {
      const { rows } = await pool.query(
        `SELECT p.*,
                (SELECT COUNT(*) FROM propostas pr
                  WHERE pr.pedido_id = p.id AND pr.status = 'pendente') AS ofertas
         FROM pedidos p
         WHERE p.status = 'aberto' AND p.passageiro_id = $1
         ORDER BY p.created_at DESC`,
        [req.user.id]
      );
      return res.json(rows);
    }

    // Com lat/lng (mapa do motorista): só pedidos DENTRO do raio de visibilidade,
    // os mais perto primeiro — carona é entre gente próxima.
    if (lat && lng) {
      const pid = await projetoDoUsuario(req.user.id);
      if (!pid) return res.json([]);
      const distOrigem = haversine("p.origem_lat", "p.origem_lng", "$1", "$2");
      const params = [lat, lng, RAIO_VISIVEL_KM];
      if (pid) params.push(pid);
      const filtroProj = pid ? `AND u.projeto_id = $${params.length}` : "";
      const { rows } = await pool.query(
        `SELECT * FROM (
           SELECT p.*, u.nome AS passageiro_nome, u.sexo AS passageiro_sexo,
                  ${distOrigem} AS dist_origem
           FROM pedidos p
           JOIN usuarios u ON p.passageiro_id = u.id
           WHERE p.status = 'aberto'
             AND COALESCE(u.ativo, TRUE) = TRUE
             AND (p.horario IS NULL OR p.horario <= NOW())
             ${filtroProj}
         ) s
         WHERE s.dist_origem <= $3
         ORDER BY s.dist_origem ASC
         LIMIT 60`,
        params
      );
      return res.json(rows);
    }

    const pid = await projetoDoUsuario(req.user.id);
    if (!pid) return res.json([]);
    const params = [pid];
    const filtroProj = `AND u.projeto_id = $1`;
    const { rows } = await pool.query(
      `SELECT p.*, u.nome AS passageiro_nome, u.sexo AS passageiro_sexo
       FROM pedidos p
       JOIN usuarios u ON p.passageiro_id = u.id
       WHERE p.status = 'aberto'
         AND COALESCE(u.ativo, TRUE) = TRUE
         AND (p.horario IS NULL OR p.horario <= NOW())
         ${filtroProj}
       ORDER BY p.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar pedidos" });
  }
});

app.delete("/api/pedidos/:id", verificarAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE pedidos SET status = 'cancelado'
       WHERE id = $1 AND passageiro_id = $2 AND status = 'aberto'`,
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Pedido não encontrado" });
    // Libera quem ofereceu: as propostas pendentes deste pedido caem para recusado,
    // assim o motorista não fica preso na tela "Aguardando aceitar".
    await pool.query(
      `UPDATE propostas SET status = 'recusado'
       WHERE pedido_id = $1 AND status = 'pendente'`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao cancelar pedido" });
  }
});

/* ============================ MATCH ============================ */
// Caronas que combinam com um pedido (origem perto E destino perto)
app.get("/api/caronas/match", verificarAuth, async (req, res) => {
  const { pedido_id } = req.query;
  if (!pedido_id) return res.status(400).json({ error: "pedido_id obrigatório" });
  try {
    const pid = await exigirProjeto(req.user.id, res);
    if (!pid) return;

    const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1", [pedido_id])).rows[0];
    if (!ped) return res.status(404).json({ error: "Pedido não encontrado" });
    if (ped.passageiro_id !== req.user.id) return res.status(403).json({ error: "Pedido de outro usuário" });

    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT c.*, u.nome AS motorista_nome, h.placa, h.tag, h.foto_carro_url,
                ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} AS dist_origem,
                ${haversine("c.destino_lat", "c.destino_lng", "$3", "$4")} AS dist_destino
         FROM caronas c
         JOIN usuarios u ON c.motorista_id = u.id
         LEFT JOIN habilitacoes_motorista h ON c.habilitacao_id = h.id
         WHERE c.status = 'ativa' AND c.motorista_id <> $5
           AND u.projeto_id = $8
           AND COALESCE(u.ativo, TRUE) = TRUE
           AND (c.horario IS NULL OR $7::timestamp IS NULL
                OR ABS(EXTRACT(EPOCH FROM (c.horario - $7::timestamp))) <= 3600)
       ) s
       WHERE s.dist_origem <= $6 AND s.dist_destino <= $6
       ORDER BY (s.dist_origem + s.dist_destino) ASC
       LIMIT 20`,
      [ped.origem_lat, ped.origem_lng, ped.destino_lat, ped.destino_lng, req.user.id, RAIO_KM, ped.horario, pid]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar caronas" });
  }
});

// Pedidos que combinam com uma carona (origem perto E destino perto)
app.get("/api/pedidos/match", verificarAuth, async (req, res) => {
  const { carona_id } = req.query;
  if (!carona_id) return res.status(400).json({ error: "carona_id obrigatório" });
  try {
    const pid = await exigirProjeto(req.user.id, res);
    if (!pid) return;

    const car = (await pool.query("SELECT * FROM caronas WHERE id = $1", [carona_id])).rows[0];
    if (!car) return res.status(404).json({ error: "Carona não encontrada" });

    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT p.*, u.nome AS passageiro_nome,
                ${haversine("p.origem_lat", "p.origem_lng", "$1", "$2")} AS dist_origem,
                ${haversine("p.destino_lat", "p.destino_lng", "$3", "$4")} AS dist_destino
         FROM pedidos p
         JOIN usuarios u ON p.passageiro_id = u.id
         WHERE p.status = 'aberto' AND p.passageiro_id <> $5
           AND u.projeto_id = $8
           AND COALESCE(u.ativo, TRUE) = TRUE
           AND (p.horario IS NULL OR $7::timestamp IS NULL
                OR ABS(EXTRACT(EPOCH FROM (p.horario - $7::timestamp))) <= 3600)
       ) s
       WHERE s.dist_origem <= $6 AND s.dist_destino <= $6
       ORDER BY (s.dist_origem + s.dist_destino) ASC
       LIMIT 20`,
      [car.origem_lat, car.origem_lng, car.destino_lat, car.destino_lng, req.user.id, RAIO_KM, car.horario, pid]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar pedidos" });
  }
});

/* ============================ PROPOSTAS ============================ */
app.post("/api/propostas", verificarAuth, async (req, res) => {
  const { carona_id, pedido_id, mensagem, selfie_url, selfie_lat, selfie_lng, selfie_em } = req.body;
  if (!carona_id && !pedido_id) return res.status(400).json({ error: "Informe carona_id ou pedido_id" });

  try {
    let para_usuario_id, dadosSelfie = {};

    if (carona_id) {
      // Passageiro pedindo uma vaga numa carona -> precisa de selfie
      if (!selfie_url) return res.status(400).json({ error: "Selfie é obrigatória para pedir vaga" });
      const car = (await pool.query("SELECT * FROM caronas WHERE id = $1 AND status = 'ativa'", [carona_id])).rows[0];
      if (!car) return res.status(404).json({ error: "Carona indisponível" });
      if (car.motorista_id === req.user.id) return res.status(400).json({ error: "Você é o motorista desta carona" });
      if (!(await validarMesmoProjeto(req.user.id, car.motorista_id, res))) return;
      para_usuario_id = car.motorista_id;
      dadosSelfie = { selfie_url, selfie_lat, selfie_lng, selfie_em: selfie_em || new Date() };
    } else {
      // Motorista oferecendo carona a um pedido -> precisa de habilitação ativa
      const hab = await habilitacaoAtiva(req.user.id);
      if (!hab) return res.status(403).json({ error: "Ative o modo motorista antes de oferecer carona" });
      const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1 AND status = 'aberto'", [pedido_id])).rows[0];
      if (!ped) return res.status(404).json({ error: "Pedido indisponível" });
      if (ped.passageiro_id === req.user.id) return res.status(400).json({ error: "Este pedido é seu" });
      if (!(await validarMesmoProjeto(req.user.id, ped.passageiro_id, res))) return;
      para_usuario_id = ped.passageiro_id;
    }

    const { rows } = await pool.query(
      `INSERT INTO propostas
         (de_usuario_id, para_usuario_id, carona_id, pedido_id, mensagem,
          selfie_url, selfie_lat, selfie_lng, selfie_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        req.user.id, para_usuario_id, carona_id || null, pedido_id || null, mensagem || null,
        dadosSelfie.selfie_url || null, dadosSelfie.selfie_lat || null,
        dadosSelfie.selfie_lng || null, dadosSelfie.selfie_em || null,
      ]
    );
    res.json(rows[0]);

    // Notifica quem recebeu a solicitação (mesmo com o app fechado).
    const deNome = (await pool.query("SELECT nome FROM usuarios WHERE id = $1", [req.user.id])).rows[0]?.nome || "Um colega";
    enviarPush(para_usuario_id, {
      title: "Nova solicitação de carona",
      body: carona_id ? `${deNome} pediu uma vaga na sua carona.` : `${deNome} ofereceu uma carona para você.`,
      url: "/dashboard.html",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao enviar proposta" });
  }
});

app.get("/api/propostas", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pr.*,
              du.nome AS de_nome, pu.nome AS para_nome,
              CASE WHEN pr.status = 'aceito' THEN du.telefone ELSE NULL END AS de_telefone,
              CASE WHEN pr.status = 'aceito' THEN pu.telefone ELSE NULL END AS para_telefone,
              c.origem_texto AS c_origem, c.destino_texto AS c_destino, c.horario AS c_horario,
              p.origem_texto AS p_origem, p.destino_texto AS p_destino, p.horario AS p_horario,
              v.id AS viagem_id, v.status AS viagem_status,
              COALESCE(hm.selfie_url, hped.selfie_url) AS motorista_selfie,
              COALESCE(hm.selfie_em, hped.selfie_em) AS motorista_selfie_em,
              COALESCE(hm.foto_carro_url, hped.foto_carro_url) AS motorista_carro,
              COALESCE(hm.foto_carro_em, hped.foto_carro_em) AS motorista_carro_em,
              COALESCE(hm.placa, hped.placa) AS motorista_placa,
              COALESCE(hm.tag, hped.tag) AS motorista_tag
       FROM propostas pr
       JOIN usuarios du ON pr.de_usuario_id = du.id
       JOIN usuarios pu ON pr.para_usuario_id = pu.id
       LEFT JOIN caronas c ON pr.carona_id = c.id
       LEFT JOIN pedidos p ON pr.pedido_id = p.id
       LEFT JOIN viagens v ON v.proposta_id = pr.id
       LEFT JOIN habilitacoes_motorista hm ON hm.id = c.habilitacao_id
       LEFT JOIN LATERAL (
         SELECT selfie_url, selfie_em, foto_carro_url, foto_carro_em, placa, tag
         FROM habilitacoes_motorista
         WHERE motorista_id = pr.de_usuario_id AND status = 'ativa'
           AND ${sqlSelfieValida("")}
         ORDER BY created_at DESC LIMIT 1
       ) hped ON pr.pedido_id IS NOT NULL
       WHERE pr.de_usuario_id = $1 OR pr.para_usuario_id = $1
       ORDER BY pr.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(rows.map((r) => ({ ...r, sou_destinatario: r.para_usuario_id === req.user.id })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar propostas" });
  }
});

// Cria a viagem a partir de uma proposta aceita (idempotente). Liga motorista
// e passageiro, copia a rota e marca a carona/pedido como atendido.
async function criarViagemDaProposta(propostaId) {
  const pr = (await pool.query("SELECT * FROM propostas WHERE id = $1 AND status = 'aceito'", [propostaId])).rows[0];
  if (!pr) return null;
  const existente = (await pool.query("SELECT * FROM viagens WHERE proposta_id = $1", [propostaId])).rows[0];
  if (existente) return existente;

  // Ponto de encontro (embarque) e destino. O encontro é SEMPRE onde o passageiro
  // está; o destino é para onde ele quer ir.
  let motorista_id, passageiro_id, embarque, destino;
  if (pr.carona_id) {
    motorista_id = pr.para_usuario_id; passageiro_id = pr.de_usuario_id;
    const car = (await pool.query("SELECT * FROM caronas WHERE id = $1", [pr.carona_id])).rows[0];
    // passageiro pediu vaga: o embarque é a posição dele (selfie do pedido de vaga)
    embarque = { texto: "Embarque do passageiro", lat: pr.selfie_lat || car?.origem_lat, lng: pr.selfie_lng || car?.origem_lng };
    destino = { texto: car?.destino_texto, lat: car?.destino_lat, lng: car?.destino_lng };
  } else {
    motorista_id = pr.de_usuario_id; passageiro_id = pr.para_usuario_id;
    const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1", [pr.pedido_id])).rows[0];
    embarque = { texto: ped?.origem_texto, lat: ped?.origem_lat, lng: ped?.origem_lng };
    destino = { texto: ped?.destino_texto, lat: ped?.destino_lat, lng: ped?.destino_lng };
  }
  const hab = await habilitacaoAtiva(motorista_id);

  const { rows } = await pool.query(
    `INSERT INTO viagens
       (proposta_id, carona_id, pedido_id, motorista_id, passageiro_id, habilitacao_id,
        origem_texto, origem_lat, origem_lng, destino_texto, destino_lat, destino_lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      pr.id, pr.carona_id, pr.pedido_id, motorista_id, passageiro_id, hab ? hab.id : null,
      embarque.texto || null, embarque.lat || null, embarque.lng || null,
      destino.texto || null, destino.lat || null, destino.lng || null,
    ]
  );
  if (pr.carona_id) await pool.query("UPDATE caronas SET status = 'concluida' WHERE id = $1", [pr.carona_id]);
  if (pr.pedido_id) await pool.query("UPDATE pedidos SET status = 'atendido' WHERE id = $1", [pr.pedido_id]);
  return rows[0];
}

app.post("/api/propostas/:id/aceitar", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE propostas SET status = 'aceito'
       WHERE id = $1 AND para_usuario_id = $2 AND status = 'pendente'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Proposta não encontrada" });
    // Cria a viagem na hora do aceite: já liga os dois, habilita rastreamento e contato.
    const viagem = await criarViagemDaProposta(req.params.id);
    res.json({ ...rows[0], viagem_id: viagem ? viagem.id : null });

    // Notifica quem fez a solicitação de que foi aceita (app pode estar fechado).
    enviarPush(rows[0].de_usuario_id, {
      title: "Carona confirmada!",
      body: "Sua solicitação foi aceita. Toque para acompanhar ao vivo.",
      url: "/dashboard.html",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao aceitar proposta" });
  }
});

app.post("/api/propostas/:id/recusar", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE propostas SET status = 'recusado'
       WHERE id = $1 AND para_usuario_id = $2 AND status = 'pendente'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Proposta não encontrada" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao recusar proposta" });
  }
});

// Cancela uma proposta JÁ aceita (qualquer um dos dois lados), antes da viagem
// começar. Reabre a oferta/pedido para novos matches.
app.post("/api/propostas/:id/cancelar", verificarAuth, async (req, res) => {
  try {
    // Permite cancelar uma proposta PENDENTE (chamada em espera) ou ACEITA (antes da
    // viagem iniciar). Vale para quem enviou ou recebeu.
    const pr = (await pool.query(
      `UPDATE propostas SET status = 'recusado'
       WHERE id = $1 AND (de_usuario_id = $2 OR para_usuario_id = $2)
         AND status IN ('pendente', 'aceito')
         AND NOT EXISTS (
           SELECT 1 FROM viagens v WHERE v.proposta_id = propostas.id AND v.status = 'em_andamento'
         )
       RETURNING *`,
      [req.params.id, req.user.id]
    )).rows[0];
    if (!pr) return res.status(400).json({ error: "Não é possível cancelar (viagem já iniciada ou proposta inválida)" });

    // Reabre a carona/pedido para que possam ser oferecidos de novo
    if (pr.carona_id) await pool.query("UPDATE caronas SET status = 'ativa' WHERE id = $1 AND status <> 'cancelada'", [pr.carona_id]);
    if (pr.pedido_id) await pool.query("UPDATE pedidos SET status = 'aberto' WHERE id = $1 AND status <> 'cancelado'", [pr.pedido_id]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao cancelar" });
  }
});

/* ============================ VIAGENS ============================ */
// Inicia a viagem a partir de uma proposta aceita (apenas o motorista inicia)
app.post("/api/viagens", verificarAuth, async (req, res) => {
  const { proposta_id } = req.body;
  if (!proposta_id) return res.status(400).json({ error: "proposta_id obrigatório" });

  try {
    const pr = (await pool.query("SELECT * FROM propostas WHERE id = $1 AND status = 'aceito'", [proposta_id])).rows[0];
    if (!pr) return res.status(404).json({ error: "Proposta não aceita ou inexistente" });

    // Só o motorista (lado que oferece o carro) pode iniciar manualmente.
    const motorista_id = pr.carona_id ? pr.para_usuario_id : pr.de_usuario_id;
    if (req.user.id !== motorista_id) {
      return res.status(403).json({ error: "Apenas o motorista inicia a viagem" });
    }

    const viagem = await criarViagemDaProposta(proposta_id);
    if (!viagem) return res.status(404).json({ error: "Proposta não aceita ou inexistente" });
    res.json(viagem);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao iniciar viagem" });
  }
});

// Recebe lote de pontos GPS durante o trajeto (rastreamento ao vivo)
app.post("/api/viagens/:id/pontos", verificarAuth, async (req, res) => {
  const { pontos } = req.body;
  if (!Array.isArray(pontos) || pontos.length === 0) return res.status(400).json({ error: "Sem pontos" });

  try {
    const v = (await pool.query("SELECT * FROM viagens WHERE id = $1", [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: "Viagem não encontrada" });
    if (![v.motorista_id, v.passageiro_id].includes(req.user.id)) {
      return res.status(403).json({ error: "Sem permissão" });
    }

    const values = [];
    const params = [];
    pontos.slice(0, 500).forEach((p, i) => {
      const base = i * 3;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      params.push(req.params.id, p.lat, p.lng);
    });

    await pool.query(
      `INSERT INTO viagem_pontos (viagem_id, lat, lng) VALUES ${values.join(",")}`,
      params
    );
    res.json({ success: true, gravados: Math.min(pontos.length, 500) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao gravar rota" });
  }
});

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
    await pool.query("UPDATE localizacoes_online SET disponivel = FALSE WHERE usuario_id = $1", [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro" });
  }
});

// Motoristas com carona publicada e online nos últimos 3 min (vistos pelo passageiro).
app.get("/api/motoristas-online", verificarAuth, async (req, res) => {
  const { lat, lng } = req.query;
  try {
    // Só motoristas com uma carona publicada (rota): o passageiro clica no
    // carro no mapa e pede vaga naquela carona. Com lat/lng, corta pelo raio
    // de visibilidade (carona é entre gente próxima).
    const pid = await projetoDoUsuario(req.user.id);
    if (!pid) return res.json([]);
    const params = lat && lng ? [req.user.id, lat, lng, RAIO_VISIVEL_KM] : [req.user.id];
    params.push(pid);
    const raio = lat && lng ? `AND ${haversine("l.lat", "l.lng", "$2", "$3")} <= $4` : "";
    const filtroProj = `AND u.projeto_id = $${params.length}`;
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (u.id)
              u.id, u.nome, u.sexo, l.lat, l.lng,
              h.placa, h.tag, h.foto_carro_url, h.foto_carro_em, h.selfie_url, h.selfie_em,
              ca.id AS carona_id, ca.origem_texto, ca.destino_texto,
              ca.origem_lat, ca.origem_lng, ca.destino_lat, ca.destino_lng
       FROM localizacoes_online l
       JOIN usuarios u ON u.id = l.usuario_id
       JOIN habilitacoes_motorista h
         ON h.motorista_id = u.id AND h.status = 'ativa'
            AND ${sqlSelfieValida("h")}
       JOIN caronas ca ON ca.motorista_id = u.id AND ca.status = 'ativa'
       WHERE l.disponivel = TRUE
         AND COALESCE(u.ativo, TRUE) = TRUE
         AND l.atualizado_em > NOW() - INTERVAL '3 minutes'
         AND u.id <> $1
         ${filtroProj}
         ${raio}
       ORDER BY u.id, ca.created_at DESC, h.created_at DESC
       LIMIT 100`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar motoristas" });
  }
});

// Posição ao vivo do motorista de uma viagem (passageiro acompanha o carro).
app.get("/api/viagens/:id/localizacao", verificarAuth, async (req, res) => {
  try {
    const v = (await pool.query(
      `SELECT v.motorista_id, v.passageiro_id, v.fase, v.status,
              m.sexo AS motorista_sexo, pa.sexo AS passageiro_sexo
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       WHERE v.id = $1`, [req.params.id]
    )).rows[0];
    if (!v) return res.status(404).json({ error: "Viagem não encontrada" });
    if (!req.user.is_admin && ![v.motorista_id, v.passageiro_id].includes(req.user.id)) {
      return res.status(403).json({ error: "Sem permissão" });
    }
    // Posição ao vivo dos dois lados (cada um transmite a sua) para que um veja o outro.
    const locs = (await pool.query(
      "SELECT usuario_id, lat, lng FROM localizacoes_online WHERE usuario_id = ANY($1)",
      [[v.motorista_id, v.passageiro_id]]
    )).rows;
    const posDe = (id) => { const l = locs.find((x) => x.usuario_id === id); return l ? { lat: l.lat, lng: l.lng } : null; };
    // Sempre devolve fase/status (o passageiro reage à mudança), mesmo sem posição ainda.
    // `lat/lng` no topo = posição do motorista (compatível com versões antigas do app).
    const motorista = posDe(v.motorista_id);
    res.json({
      ...(motorista || {}),
      motorista, passageiro: posDe(v.passageiro_id),
      motorista_sexo: v.motorista_sexo, passageiro_sexo: v.passageiro_sexo,
      fase: v.fase, status: v.status,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao obter localização" });
  }
});

// Motorista chegou ao passageiro e embarcou: muda a fase para 'destino'.
app.post("/api/viagens/:id/iniciar", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE viagens SET fase = 'destino'
       WHERE id = $1 AND motorista_id = $2 AND status = 'em_andamento'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Viagem não encontrada" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao iniciar a viagem" });
  }
});

app.post("/api/viagens/:id/finalizar", verificarAuth, async (req, res) => {
  try {
    const v = (await pool.query("SELECT * FROM viagens WHERE id = $1", [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: "Viagem não encontrada" });
    if (req.user.id !== v.motorista_id) return res.status(403).json({ error: "Apenas o motorista finaliza" });

    // Distância total somando os trechos consecutivos (Haversine via LAG)
    const distQ = await pool.query(
      `WITH p AS (
         SELECT lat, lng,
                LAG(lat) OVER (ORDER BY registrado_em) AS plat,
                LAG(lng) OVER (ORDER BY registrado_em) AS plng
         FROM viagem_pontos WHERE viagem_id = $1)
       SELECT COALESCE(SUM(
         6371 * acos(LEAST(1, GREATEST(-1,
           cos(radians(plat)) * cos(radians(lat)) * cos(radians(lng) - radians(plng))
           + sin(radians(plat)) * sin(radians(lat))
         )))
       ), 0) AS km
       FROM p WHERE plat IS NOT NULL`,
      [req.params.id]
    );

    const km = Math.round(Number(distQ.rows[0].km) * 100) / 100;
    const { rows } = await pool.query(
      `UPDATE viagens SET status = 'concluida', finalizada_em = NOW(), distancia_km = $2
       WHERE id = $1 RETURNING *`,
      [req.params.id, km]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao finalizar viagem" });
  }
});

app.get("/api/viagens", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.*, m.nome AS motorista_nome, pa.nome AS passageiro_nome,
              (SELECT COUNT(*) FROM viagem_pontos vp WHERE vp.viagem_id = v.id) AS qtd_pontos
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       WHERE v.motorista_id = $1 OR v.passageiro_id = $1
       ORDER BY v.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar viagens" });
  }
});

app.get("/api/viagens/:id", verificarAuth, async (req, res) => {
  try {
    const v = (await pool.query(
      `SELECT v.*, m.nome AS motorista_nome, m.telefone AS motorista_telefone, m.sexo AS motorista_sexo,
              pa.nome AS passageiro_nome, pa.telefone AS passageiro_telefone, pa.sexo AS passageiro_sexo,
              h.placa, h.tag, h.foto_carro_url, h.foto_carro_em, h.selfie_url AS motorista_selfie,
              pr.selfie_url AS passageiro_selfie, pd.selfie_url AS pedido_selfie
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       LEFT JOIN habilitacoes_motorista h ON v.habilitacao_id = h.id
       LEFT JOIN propostas pr ON v.proposta_id = pr.id
       LEFT JOIN pedidos pd ON v.pedido_id = pd.id
       WHERE v.id = $1`,
      [req.params.id]
    )).rows[0];

    if (!v) return res.status(404).json({ error: "Viagem não encontrada" });
    if (!req.user.is_admin && ![v.motorista_id, v.passageiro_id].includes(req.user.id)) {
      return res.status(403).json({ error: "Sem permissão" });
    }

    // Decima o trajeto para no máx. ~500 pontos (mantendo sempre o primeiro e o
    // último) — viagens longas geram milhares de pontos e o traçado não precisa.
    const pontos = (await pool.query(
      `SELECT lat, lng, registrado_em FROM (
         SELECT lat, lng, registrado_em,
                ROW_NUMBER() OVER (ORDER BY registrado_em ASC) AS rn,
                COUNT(*) OVER () AS total
         FROM viagem_pontos WHERE viagem_id = $1
       ) s
       WHERE (s.rn - 1) % GREATEST(1, CEIL(s.total / 500.0)::int) = 0 OR s.rn = s.total
       ORDER BY s.registrado_em ASC`,
      [req.params.id]
    )).rows;

    res.json({ ...v, pontos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao carregar viagem" });
  }
});

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
         WHERE v.status = 'concluida' AND m.projeto_id = $1`,
        [pid]
      ),
    ]);
    const viagens = (await pool.query(
      `SELECT v.id, v.status, v.distancia_km, v.iniciada_em,
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
           AND v.finalizada_em >= $2::timestamptz AND v.finalizada_em < $3::timestamptz`,
        [pid, periodo.de, periodo.ate]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT sub.uid) AS usuarios_ativos
         FROM (
           SELECT v.motorista_id AS uid FROM viagens v
           JOIN usuarios m ON v.motorista_id = m.id
           WHERE m.projeto_id = $1 AND v.status = 'concluida'
             AND v.finalizada_em >= $2::timestamptz AND v.finalizada_em < $3::timestamptz
           UNION
           SELECT v.passageiro_id FROM viagens v
           JOIN usuarios m ON v.motorista_id = m.id
           WHERE m.projeto_id = $1 AND v.status = 'concluida'
             AND v.finalizada_em >= $2::timestamptz AND v.finalizada_em < $3::timestamptz
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

app.get("/api/admin/rateio", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const periodo = periodoFromQuery(req.query.de, req.query.ate);
  if (!periodo) return res.status(400).json({ error: "Período inválido" });
  const pid = req.adminEscopo.admin_projeto_id;
  const valorContrato = Number(req.adminEscopo.valor_contrato_mensal) || 0;
  try {
    const base = await pool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(pa.empresa_nome), ''), 'Sem empresa') AS empresa_nome,
         COALESCE(NULLIF(TRIM(pa.centro_custo), ''), 'Sem CC') AS centro_custo,
         COUNT(*)::int AS viagens,
         COALESCE(SUM(v.distancia_km), 0) AS km
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       WHERE m.projeto_id = $1 AND v.status = 'concluida'
         AND v.finalizada_em >= $2::timestamptz AND v.finalizada_em < $3::timestamptz
       GROUP BY 1, 2`,
      [pid, periodo.de, periodo.ate]
    );
    const totais = await pool.query(
      `SELECT COUNT(*)::int AS viagens, COALESCE(SUM(v.distancia_km), 0) AS km
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       WHERE m.projeto_id = $1 AND v.status = 'concluida'
         AND v.finalizada_em >= $2::timestamptz AND v.finalizada_em < $3::timestamptz`,
      [pid, periodo.de, periodo.ate]
    );
    const ativosQ = await pool.query(
      `SELECT COUNT(DISTINCT sub.uid) AS usuarios_ativos
       FROM (
         SELECT v.motorista_id AS uid FROM viagens v
         JOIN usuarios m ON v.motorista_id = m.id
         WHERE m.projeto_id = $1 AND v.status = 'concluida'
           AND v.finalizada_em >= $2::timestamptz AND v.finalizada_em < $3::timestamptz
         UNION
         SELECT v.passageiro_id FROM viagens v
         JOIN usuarios m ON v.motorista_id = m.id
         WHERE m.projeto_id = $1 AND v.status = 'concluida'
           AND v.finalizada_em >= $2::timestamptz AND v.finalizada_em < $3::timestamptz
       ) sub`,
      [pid, periodo.de, periodo.ate]
    );
    const totalViagens = totais.rows[0].viagens || 0;
    const totalKm = Number(totais.rows[0].km) || 0;
    const usuariosAtivos = ativosQ.rows[0].usuarios_ativos || 0;

    const porEmpresaMap = {};
    const porCc = [];
    for (const row of base.rows) {
      const share = totalViagens ? row.viagens / totalViagens : 0;
      const custo = Math.round(valorContrato * share * 100) / 100;
      porCc.push({
        empresa_nome: row.empresa_nome,
        centro_custo: row.centro_custo,
        viagens: row.viagens,
        km: Math.round(Number(row.km) * 100) / 100,
        custo_alocado: custo,
        percentual: Math.round(share * 10000) / 100,
      });
      if (!porEmpresaMap[row.empresa_nome]) {
        porEmpresaMap[row.empresa_nome] = { empresa_nome: row.empresa_nome, viagens: 0, km: 0, custo_alocado: 0 };
      }
      porEmpresaMap[row.empresa_nome].viagens += row.viagens;
      porEmpresaMap[row.empresa_nome].km += Number(row.km);
      porEmpresaMap[row.empresa_nome].custo_alocado += custo;
    }
    const porEmpresa = Object.values(porEmpresaMap).map((e) => ({
      ...e,
      km: Math.round(e.km * 100) / 100,
      custo_alocado: Math.round(e.custo_alocado * 100) / 100,
      percentual: totalViagens ? Math.round((e.viagens / totalViagens) * 10000) / 100 : 0,
    })).sort((a, b) => b.viagens - a.viagens);

    res.json({
      periodo: { de: periodo.de, ate: periodo.ate },
      valor_contrato_mensal: valorContrato,
      totais: {
        viagens: totalViagens,
        km: Math.round(totalKm * 100) / 100,
        usuarios_ativos: usuariosAtivos,
        custo_por_km: totalKm ? Math.round((valorContrato / totalKm) * 100) / 100 : 0,
        custo_por_usuario: usuariosAtivos ? Math.round((valorContrato / usuariosAtivos) * 100) / 100 : 0,
        custo_por_viagem: totalViagens ? Math.round((valorContrato / totalViagens) * 100) / 100 : 0,
      },
      por_empresa: porEmpresa,
      por_centro_custo: porCc.sort((a, b) => b.viagens - a.viagens),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao calcular rateio" });
  }
});


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

app.post("/api/admin/reset-senha", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const { matricula } = req.body;
  if (!matricula || matricula.length < 6) return res.status(400).json({ error: "Matrícula inválida" });
  const pid = req.adminEscopo.admin_projeto_id;
  try {
    const senha_hash = await bcrypt.hash("123456", 10);
    const { rowCount } = await pool.query(
      "UPDATE usuarios SET senha_hash = $1 WHERE matricula = $2 AND projeto_id = $3",
      [senha_hash, matricula.trim(), pid]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Usuário não encontrado neste projeto" });
    res.json({ success: true, message: `Senha de ${matricula} resetada para: 123456` });
  } catch (err) {
    res.status(500).json({ error: "Erro interno" });
  }
});

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
    <p style="margin-top:20px"><a href="${baseUrl}/admin.html">Abrir painel admin para aprovar ou recusar</a></p>
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

// Fila de solicitações admin do projeto (painel comercial).
app.get("/api/admin/chamados", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const pid = req.adminEscopo.admin_projeto_id;
  const status = req.query.status || "pendente";
  try {
    const { rows } = await pool.query(
      `SELECT c.*, p.nome AS projeto_nome, p.codigo AS projeto_codigo
       FROM admin_chamados c
       LEFT JOIN projetos p ON p.id = c.projeto_id
       WHERE c.projeto_id = $1 AND c.status = $2
       ORDER BY c.created_at DESC`,
      [pid, status]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Aprova chamado: cria ou promove usuário a admin do projeto (senha inicial 123456).
app.post("/api/admin/chamados/:id/aprovar", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const pid = req.adminEscopo.admin_projeto_id;
  const chamadoId = parseInt(req.params.id, 10);
  if (!chamadoId) return res.status(400).json({ error: "ID inválido" });

  try {
    const { rows: chamados } = await pool.query(
      "SELECT * FROM admin_chamados WHERE id = $1 AND projeto_id = $2 AND status = 'pendente'",
      [chamadoId, pid]
    );
    const c = chamados[0];
    if (!c) return res.status(404).json({ error: "Solicitação não encontrada ou já processada" });

    const bloqueada = await pool.query("SELECT 1 FROM matriculas_bloqueadas WHERE matricula = $1", [c.matricula]);
    if (bloqueada.rows.length > 0) {
      return res.status(400).json({ error: "Matrícula bloqueada — não é possível aprovar" });
    }

    const senha_hash = await bcrypt.hash("123456", 10);
    const existente = (await pool.query("SELECT id FROM usuarios WHERE matricula = $1", [c.matricula])).rows[0];

    if (existente) {
      await pool.query(
        `UPDATE usuarios SET
           is_admin = TRUE, admin_projeto_id = $1, projeto_id = $1,
           nome = COALESCE($2, nome), empresa_nome = COALESCE($3, empresa_nome),
           telefone = COALESCE($4, telefone), email = COALESCE($5, email),
           ativo = TRUE
         WHERE id = $6`,
        [pid, c.nome, c.empresa_nome, c.telefone, c.email, existente.id]
      );
    } else {
      await pool.query(
        `INSERT INTO usuarios (nome, matricula, senha_hash, telefone, email, is_admin, empresa_nome, projeto_id, admin_projeto_id, ativo)
         VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$7,TRUE)`,
        [c.nome, c.matricula, senha_hash, c.telefone, c.email, c.empresa_nome, pid]
      );
    }

    await pool.query("UPDATE admin_chamados SET status = 'aprovado' WHERE id = $1", [chamadoId]);
    res.json({
      message: `Admin aprovado! Matrícula ${c.matricula} — senha inicial: 123456 (peça para trocar no primeiro login).`,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao aprovar solicitação" });
  }
});

app.post("/api/admin/chamados/:id/recusar", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const pid = req.adminEscopo.admin_projeto_id;
  const chamadoId = parseInt(req.params.id, 10);
  if (!chamadoId) return res.status(400).json({ error: "ID inválido" });

  try {
    const { rowCount } = await pool.query(
      "UPDATE admin_chamados SET status = 'recusado' WHERE id = $1 AND projeto_id = $2 AND status = 'pendente'",
      [chamadoId, pid]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Solicitação não encontrada ou já processada" });
    res.json({ message: "Solicitação recusada." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================ ESTÁTICOS ============================ */
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error("ERRO GLOBAL:", err.message);
  res.status(500).json({ error: "Erro interno no servidor" });
});

app.listen(PORT, () => {
  console.log(`VAP rodando em http://localhost:${PORT}`);
});
