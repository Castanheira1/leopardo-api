const express = require("express");
const path = require("path");
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
app.use(cors({ origin: "*" }));
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
  .then((client) => { console.log("Conectado ao PostgreSQL"); client.release(); garantirColunasUsuarios(); garantirTabelaPush(); garantirColunasViagens(); garantirColunasPedidos(); })
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
    const data = JSON.stringify(payload);
    await Promise.all(rows.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [s.endpoint]).catch(() => {});
        }
      }
    }));
  } catch (err) {
    console.error("enviarPush:", err.message);
  }
}

// Auto-heal: o pedido guarda quantas pessoas vão na carona.
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
    const nome = (await pool.query("SELECT nome FROM usuarios WHERE id = $1", [ped.passageiro_id])).rows[0]?.nome || "Um colega";
    const motoristas = (await pool.query(
      `SELECT motorista_id FROM (
         SELECT DISTINCT ON (h.motorista_id) h.motorista_id, l.atualizado_em,
                ${haversine("l.lat", "l.lng", "$1", "$2")} AS dist
         FROM habilitacoes_motorista h
         JOIN localizacoes_online l ON l.usuario_id = h.motorista_id
         WHERE h.status = 'ativa' AND h.created_at > NOW() - INTERVAL '24 hours'
           AND h.motorista_id <> $3
         ORDER BY h.motorista_id, h.created_at DESC
       ) s
       WHERE (s.atualizado_em > NOW() - INTERVAL '10 minutes' AND s.dist <= $4)
          OR s.dist <= $5
       ORDER BY s.dist ASC
       LIMIT 8`,
      [ped.origem_lat, ped.origem_lng, ped.passageiro_id, RAIO_VISIVEL_KM, RAIO_PUSH_PERTO_KM]
    )).rows;
    const destino = ped.destino_texto ? ` para ${ped.destino_texto}` : " aqui perto";
    motoristas.forEach((m) => enviarPush(m.motorista_id, {
      title: "🙋 Carona perto de você",
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
app.post("/api/register", async (req, res) => {
  const { nome, funcao, matricula, telefone, email, senha, empresa_nome, projeto_id, centro_custo, sexo } = req.body;
  const sexoNorm = sexo === "M" || sexo === "F" ? sexo : null;
  if (!nome || !matricula || !senha || !telefone || !email) {
    return res.status(400).json({ error: "Nome, matrícula, telefone, email e senha são obrigatórios" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    return res.status(400).json({ error: "Email inválido" });
  }

  try {
    const check = await pool.query("SELECT id FROM usuarios WHERE matricula = $1", [matricula]);
    if (check.rows.length > 0) {
      return res.status(400).json({ error: "Matrícula já cadastrada" });
    }

    const senha_hash = await bcrypt.hash(senha, 10);
    const is_admin = matricula === "000000";
    const pid = projeto_id ? parseInt(projeto_id, 10) || null : null;

    const { rows } = await pool.query(
      `INSERT INTO usuarios (nome, matricula, senha_hash, funcao, telefone, email, is_admin, empresa_nome, projeto_id, centro_custo, sexo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, nome, matricula, telefone, email, is_admin, empresa_nome, projeto_id, centro_custo, sexo`,
      [nome, matricula, senha_hash, funcao || null, telefone, String(email).trim().toLowerCase(), is_admin,
       empresa_nome || null, pid, centro_custo || null, sexoNorm]
    );

    const token = jwt.sign({ id: rows[0].id, matricula, is_admin }, JWT_SECRET, { expiresIn: "8h" });
    res.json({ success: true, token, user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao criar conta" });
  }
});

app.post("/api/login", async (req, res) => {
  const { matricula, senha } = req.body;
  if (!matricula || !senha) return res.status(400).json({ error: "Campos obrigatórios" });

  try {
    const { rows } = await pool.query("SELECT * FROM usuarios WHERE matricula = $1", [matricula]);
    if (rows.length === 0) return res.status(401).json({ error: "Credenciais inválidas" });

    const user = rows[0];
    const valido = await bcrypt.compare(senha, user.senha_hash);
    if (!valido) return res.status(401).json({ error: "Credenciais inválidas" });

    const token = jwt.sign(
      { id: user.id, matricula: user.matricula, is_admin: user.is_admin },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      token,
      user: {
        id: user.id, nome: user.nome, matricula: user.matricula,
        telefone: user.telefone, is_admin: user.is_admin, sexo: user.sexo,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// Recuperação de senha SEM email: o usuário comprova identidade com a matrícula
// + o telefone que cadastrou, e define uma nova senha na hora. Opção gratuita,
// sem SMS/email. Para quem não cadastrou telefone, sobra o reset pelo admin.
app.post("/api/recuperar-senha", async (req, res) => {
  const { matricula, telefone, nova_senha } = req.body;
  if (!matricula || !telefone || !nova_senha) {
    return res.status(400).json({ error: "Preencha matrícula, telefone e a nova senha" });
  }
  if (String(nova_senha).length < 4) {
    return res.status(400).json({ error: "A nova senha deve ter pelo menos 4 caracteres" });
  }

  // Compara apenas os dígitos, ignorando formatação ((11) 9 9999-9999 etc.).
  const soDigitos = (v) => String(v || "").replace(/\D/g, "");

  try {
    const { rows } = await pool.query(
      "SELECT id, telefone FROM usuarios WHERE matricula = $1",
      [String(matricula).trim()]
    );
    const user = rows[0];
    // Mensagem genérica para não revelar se a matrícula existe.
    if (!user || !user.telefone) {
      return res.status(400).json({ error: "Dados não conferem. Procure o administrador." });
    }
    if (soDigitos(user.telefone) !== soDigitos(telefone)) {
      return res.status(400).json({ error: "Dados não conferem. Procure o administrador." });
    }

    const senha_hash = await bcrypt.hash(String(nova_senha), 10);
    await pool.query("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [senha_hash, user.id]);
    res.json({ success: true, message: "Senha alterada! Já pode entrar com a nova senha." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.get("/api/perfil", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, nome, funcao, matricula, telefone, is_admin, sexo FROM usuarios WHERE id = $1",
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao carregar perfil" });
  }
});

app.patch("/api/perfil", verificarAuth, async (req, res) => {
  const { telefone, nome, funcao, sexo } = req.body;
  const sexoNorm = sexo === "M" || sexo === "F" ? sexo : null;
  try {
    const { rows } = await pool.query(
      `UPDATE usuarios SET
         telefone = COALESCE($1, telefone),
         nome = COALESCE($2, nome),
         funcao = COALESCE($3, funcao),
         sexo = COALESCE($4, sexo)
       WHERE id = $5
       RETURNING id, nome, funcao, matricula, telefone, is_admin, sexo`,
      [telefone || null, nome || null, funcao || null, sexoNorm, req.user.id]
    );
    res.json(rows[0]);
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
         AND created_at > NOW() - INTERVAL '24 hours'
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
    placa, tag,
    foto_carro_url, foto_carro_lat, foto_carro_lng, foto_carro_em,
    selfie_url, selfie_lat, selfie_lng, selfie_em,
  } = req.body;

  if (!placa) return res.status(400).json({ error: "Placa é obrigatória" });
  if (!foto_carro_url) return res.status(400).json({ error: "Foto do carro é obrigatória" });
  if (!selfie_url) return res.status(400).json({ error: "Selfie é obrigatória" });

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
        selfie_url, selfie_lat || null, selfie_lng || null, selfie_em || new Date(),
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
       AND created_at > NOW() - INTERVAL '24 hours'
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
    const dist = lat && lng ? `, ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} AS dist_origem` : "";
    const raio = lat && lng ? `AND ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} <= $3` : "";
    const params = lat && lng ? [lat, lng, RAIO_VISIVEL_KM] : [];
    const orderBy = lat && lng ? "dist_origem ASC" : "c.created_at DESC";

    const { rows } = await pool.query(
      `SELECT c.*, u.nome AS motorista_nome, h.placa, h.tag, h.foto_carro_url ${dist}
       FROM caronas c
       JOIN usuarios u ON c.motorista_id = u.id
       LEFT JOIN habilitacoes_motorista h ON c.habilitacao_id = h.id
       WHERE c.status = 'ativa'
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
      const distOrigem = haversine("p.origem_lat", "p.origem_lng", "$1", "$2");
      const { rows } = await pool.query(
        `SELECT * FROM (
           SELECT p.*, u.nome AS passageiro_nome, u.sexo AS passageiro_sexo,
                  ${distOrigem} AS dist_origem
           FROM pedidos p
           JOIN usuarios u ON p.passageiro_id = u.id
           WHERE p.status = 'aberto'
             AND (p.horario IS NULL OR p.horario <= NOW())
         ) s
         WHERE s.dist_origem <= $3
         ORDER BY s.dist_origem ASC
         LIMIT 60`,
        [lat, lng, RAIO_VISIVEL_KM]
      );
      return res.json(rows);
    }

    const { rows } = await pool.query(
      `SELECT p.*, u.nome AS passageiro_nome, u.sexo AS passageiro_sexo
       FROM pedidos p
       JOIN usuarios u ON p.passageiro_id = u.id
       WHERE p.status = 'aberto'
         AND (p.horario IS NULL OR p.horario <= NOW())
       ORDER BY p.created_at DESC`
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
    const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1", [pedido_id])).rows[0];
    if (!ped) return res.status(404).json({ error: "Pedido não encontrado" });

    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT c.*, u.nome AS motorista_nome, h.placa, h.tag, h.foto_carro_url,
                ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} AS dist_origem,
                ${haversine("c.destino_lat", "c.destino_lng", "$3", "$4")} AS dist_destino
         FROM caronas c
         JOIN usuarios u ON c.motorista_id = u.id
         LEFT JOIN habilitacoes_motorista h ON c.habilitacao_id = h.id
         WHERE c.status = 'ativa' AND c.motorista_id <> $5
           AND (c.horario IS NULL OR $7::timestamp IS NULL
                OR ABS(EXTRACT(EPOCH FROM (c.horario - $7::timestamp))) <= 3600)
       ) s
       WHERE s.dist_origem <= $6 AND s.dist_destino <= $6
       ORDER BY (s.dist_origem + s.dist_destino) ASC
       LIMIT 20`,
      [ped.origem_lat, ped.origem_lng, ped.destino_lat, ped.destino_lng, req.user.id, RAIO_KM, ped.horario]
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
           AND (p.horario IS NULL OR $7::timestamp IS NULL
                OR ABS(EXTRACT(EPOCH FROM (p.horario - $7::timestamp))) <= 3600)
       ) s
       WHERE s.dist_origem <= $6 AND s.dist_destino <= $6
       ORDER BY (s.dist_origem + s.dist_destino) ASC
       LIMIT 20`,
      [car.origem_lat, car.origem_lng, car.destino_lat, car.destino_lng, req.user.id, RAIO_KM, car.horario]
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
      para_usuario_id = car.motorista_id;
      dadosSelfie = { selfie_url, selfie_lat, selfie_lng, selfie_em: selfie_em || new Date() };
    } else {
      // Motorista oferecendo carona a um pedido -> precisa de habilitação ativa
      const hab = await habilitacaoAtiva(req.user.id);
      if (!hab) return res.status(403).json({ error: "Ative o modo motorista antes de oferecer carona" });
      const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1 AND status = 'aberto'", [pedido_id])).rows[0];
      if (!ped) return res.status(404).json({ error: "Pedido indisponível" });
      if (ped.passageiro_id === req.user.id) return res.status(400).json({ error: "Este pedido é seu" });
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
           AND created_at > NOW() - INTERVAL '24 hours'
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
    const raio = lat && lng ? `AND ${haversine("l.lat", "l.lng", "$2", "$3")} <= $4` : "";
    const params = lat && lng ? [req.user.id, lat, lng, RAIO_VISIVEL_KM] : [req.user.id];
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
            AND h.created_at > NOW() - INTERVAL '24 hours'
       JOIN caronas ca ON ca.motorista_id = u.id AND ca.status = 'ativa'
       WHERE l.disponivel = TRUE
         AND l.atualizado_em > NOW() - INTERVAL '3 minutes'
         AND u.id <> $1
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
app.get("/api/admin/overview", verificarAuth, verificarAdmin, async (req, res) => {
  try {
    const [u, c, p, vEm, vCon] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM usuarios"),
      pool.query("SELECT COUNT(*) FROM caronas WHERE status = 'ativa'"),
      pool.query("SELECT COUNT(*) FROM pedidos WHERE status = 'aberto'"),
      pool.query("SELECT COUNT(*) FROM viagens WHERE status = 'em_andamento'"),
      pool.query("SELECT COUNT(*) FROM viagens WHERE status = 'concluida'"),
    ]);
    const viagens = (await pool.query(
      `SELECT v.id, v.status, v.distancia_km, v.iniciada_em,
              m.nome AS motorista_nome, pa.nome AS passageiro_nome
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       ORDER BY v.created_at DESC LIMIT 50`
    )).rows;

    res.json({
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

app.post("/api/admin/reset-senha", verificarAuth, verificarAdmin, async (req, res) => {
  const { matricula } = req.body;
  if (!matricula || matricula.length < 6) return res.status(400).json({ error: "Matrícula inválida" });
  try {
    const senha_hash = await bcrypt.hash("123456", 10);
    const { rowCount } = await pool.query(
      "UPDATE usuarios SET senha_hash = $1 WHERE matricula = $2",
      [senha_hash, matricula.trim()]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Usuário não encontrado" });
    res.json({ success: true, message: `Senha de ${matricula} resetada para: 123456` });
  } catch (err) {
    res.status(500).json({ error: "Erro interno" });
  }
});

// Rateio: usuários ativos nos últimos 40 dias, agrupado por projeto/empresa/CC
app.get("/api/rateio", verificarAuth, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: "Acesso negado" });
  try {
    const projeto_id = req.query.projeto_id || null;
    const params = [];
    let filtro = "";
    if (projeto_id) { params.push(projeto_id); filtro = `AND u.projeto_id = $${params.length}`; }

    const { rows } = await pool.query(`
      SELECT
          u.id,
          u.nome,
          u.matricula,
          u.empresa_nome,
          u.centro_custo,
          p.nome AS projeto,
          p.codigo AS projeto_codigo,
          COUNT(DISTINCT v.id) AS viagens,
          5.00 AS custo_mensal
      FROM usuarios u
      LEFT JOIN projetos p ON p.id = u.projeto_id
      LEFT JOIN (
          SELECT motorista_id AS usuario_id, iniciada_em FROM viagens WHERE iniciada_em >= NOW() - INTERVAL '40 days'
          UNION ALL
          SELECT passageiro_id AS usuario_id, iniciada_em FROM viagens WHERE iniciada_em >= NOW() - INTERVAL '40 days'
      ) v ON v.usuario_id = u.id
      WHERE u.is_admin = FALSE
        AND v.usuario_id IS NOT NULL
        ${filtro}
      GROUP BY u.id, u.nome, u.matricula, u.empresa_nome, u.centro_custo, p.nome, p.codigo
      ORDER BY p.nome, u.empresa_nome, u.nome
    `, params);

    const total_usuarios = rows.length;
    const total_custo = total_usuarios * 5;

    res.json({ usuarios: rows, total_usuarios, total_custo, periodo_dias: 40 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Solicitar acesso admin (validação manual futura)
app.post("/api/admin/chamados", async (req, res) => {
  const { nome, matricula, empresa_nome, projeto_id, telefone, email, justificativa } = req.body;
  if (!nome || !matricula || !telefone) return res.status(400).json({ error: "Nome, matrícula e telefone são obrigatórios" });
  try {
    await pool.query(
      `INSERT INTO admin_chamados (nome, matricula, empresa_nome, projeto_id, telefone, email, justificativa)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [nome, matricula, empresa_nome || null, projeto_id || null, telefone, email || null, justificativa || null]
    );
    res.json({ message: "Solicitação recebida. Nossa equipe entrará em contato em breve." });
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
  console.log(`Vagão rodando em http://localhost:${PORT}`);
});
