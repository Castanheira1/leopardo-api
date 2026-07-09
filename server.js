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
const ExcelJS = require("exceljs");

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
// Raio (km) do modo motorista online: pedidos no mapa, visibilidade e push (600 m).
const RAIO_ONLINE_KM = Number(process.env.RAIO_ONLINE_KM || 0.6);
// Raio (km) da faixa ao redor da ROTA (linha reta origem->destino) escolhida
// pelo passageiro: motorista "na pista" entra na fila se estiver a até esta
// distância do trajeto (não só perto da origem).
const RAIO_ROTA_KM = Number(process.env.RAIO_ROTA_KM || 1.5);
// Mesmo ponto de destino (não confundir com RAIO_VISIVEL_KM de 10 km).
const RAIO_MESMO_DEST_KM = Number(process.env.RAIO_MESMO_DEST_KM || 1.5);
// Campus / POIs próximos (ex.: Portaria ↔ Central ~3,2 km no S11D).
const RAIO_PROXIMO_KM = Number(process.env.RAIO_PROXIMO_KM || 4);
// Fila de chamada sequencial (mais perto primeiro): quanto tempo cada
// motorista tem pra responder antes de passar pro próximo da fila.
const FILA_OFERTA_TIMEOUT_S = Number(process.env.FILA_OFERTA_TIMEOUT_S || 25);
// Dois limites de GPS, para não punir sinal instável (túnel, iOS em background):
//  - FRESH: some do MAPA na hora (mata fantasma visualmente), mas a publicação
//    continua no banco — o motorista reaparece quando o GPS volta.
//  - STALE: só aqui a publicação é REALMENTE cancelada (sumiu de vez).
const GPS_FRESH_MIN = Number(process.env.GPS_FRESH_MIN || 3);
const GPS_STALE_MIN = Number(process.env.GPS_STALE_MIN || 15);
const SQL_GPS_FRESH = `atualizado_em > NOW() - INTERVAL '${GPS_FRESH_MIN} minutes'`;
const SQL_GPS_STALE = `atualizado_em <= NOW() - INTERVAL '${GPS_STALE_MIN} minutes'`;
// Mapa do passageiro: rota publicada exige GPS fresco; modo amarelo tolera até STALE
// (senão some com sinal instável entre 3–15 min, mas sem ressuscitar fantasma).
const sqlGpsVisivelMapa = (alias = "l") => `(
  (${alias}.online_desde IS NULL AND ${SQL_GPS_FRESH.replace("atualizado_em", alias + ".atualizado_em")})
  OR (${alias}.online_desde IS NOT NULL AND NOT (${SQL_GPS_STALE.replace("atualizado_em", alias + ".atualizado_em")}))
)`;

// Intervalo do "avançador" da fila (verifica ofertas vencidas).
const FILA_TICK_MS = Number(process.env.FILA_TICK_MS || 10 * 1000);
// Viagem só conta no rateio/admin se o GPS registrar deslocamento real (não simulação parado).
const KM_MINIMO_VIAGEM = Number(process.env.KM_MINIMO_VIAGEM || 0.5);
const KM_SEGMENTO_MIN = Number(process.env.KM_SEGMENTO_MIN || 0.03);
const KM_VELOCIDADE_MAX_H = Number(process.env.KM_VELOCIDADE_MAX_H || 120);
const RAIO_CHEGADA_DEST_KM = Number(process.env.RAIO_CHEGADA_DEST_KM || 0.15);
// Fuso dos projetos (canteiros Vale/PA). Horário agendado é horário de parede local.
const FUSO_APP = process.env.APP_TIMEZONE || "America/Sao_Paulo";

if (!JWT_SECRET) {
  console.error("ERRO: JWT_SECRET não definido no .env");
  process.exit(1);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression({
  filter: (req, res) => {
    if (String(req.url || "").includes("/export")) return false;
    return compression.filter(req, res);
  },
}));
// 1200: o polling legítimo de um motorista em viagem chega perto de 600/15min.
// Configurável via RATE_LIMIT_MAX (ex.: testes de carga controlados) — padrão inalterado.
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.RATE_LIMIT_MAX || 1200) }));

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

pool.on("connect", (client) => {
  client.query(`SET TIME ZONE '${FUSO_APP.replace(/'/g, "")}'`).catch(() => {});
});

pool.connect()
  .then(async (client) => {
    console.log("Conectado ao PostgreSQL");
    client.release();
    // Sequencial e em ordem de dependência: garantirColunasContatosMotorista
    // depende da tabela criada em garantirTabelaEventosUso, e garantirRlsSupabase
    // precisa de todas as tabelas já existentes. Em paralelo (sem await) havia
    // corrida — "relation contatos_motorista does not exist" no primeiro boot.
    const passos = [
      garantirColunasUsuarios, garantirTabelaPush, garantirTabelaFavoritos,
      garantirTabelaPedidoFila, garantirColunasViagens, garantirColunasPedidos,
      garantirColunasLocalizacao, limparPublicacoesFantasma, garantirIndiceCaronaUnica,
      garantirSchemaComercial, garantirTabelaAnuncios, garantirTabelaEventosUso,
      garantirColunasContatosMotorista, garantirRlsSupabase,
    ];
    for (const passo of passos) {
      try { await passo(); } catch (e) { console.warn(`${passo.name}:`, e.message); }
    }
  })
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

// Cards de propaganda/avisos exibidos ao passageiro na tela de espera.
// O admin do projeto sobe a foto e agenda a janela (inicio/fim).
async function garantirTabelaAnuncios() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS anuncios (
        id SERIAL PRIMARY KEY,
        projeto_id INTEGER REFERENCES projetos(id) ON DELETE CASCADE,
        titulo VARCHAR(160),
        imagem_url TEXT NOT NULL,
        inicio TIMESTAMPTZ NOT NULL,
        fim TIMESTAMPTZ NOT NULL,
        ativo BOOLEAN DEFAULT TRUE,
        ordem INTEGER DEFAULT 0,
        criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_anuncios_projeto_janela
      ON anuncios(projeto_id, inicio, fim) WHERE ativo = TRUE`);
  } catch (e) {
    console.warn("garantirTabelaAnuncios:", e.message);
  }
}

async function garantirTabelaEventosUso() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS eventos_uso (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        evento VARCHAR(64) NOT NULL,
        detalhes JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contatos_motorista (
        id SERIAL PRIMARY KEY,
        motorista_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        passageiro_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        mensagem TEXT,
        lido BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_contatos_motorista_pend ON contatos_motorista (motorista_id, lido, created_at DESC)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_eventos_uso_usuario ON eventos_uso (usuario_id, created_at DESC)");
  } catch (e) {
    console.warn("garantirTabelaEventosUso:", e.message);
  }
}

async function garantirColunasContatosMotorista() {
  const colunas = [
    "origem_lat NUMERIC(10,6)",
    "origem_lng NUMERIC(10,6)",
    "origem_texto TEXT",
    "destino_lat NUMERIC(10,6)",
    "destino_lng NUMERIC(10,6)",
    "destino_texto TEXT",
    "pessoas INTEGER DEFAULT 1",
    "compat_rota VARCHAR(10)",
  ];
  for (const col of colunas) {
    try {
      await pool.query(`ALTER TABLE contatos_motorista ADD COLUMN IF NOT EXISTS ${col}`);
    } catch (e) {
      console.warn("garantirColunasContatosMotorista:", e.message);
    }
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

async function garantirRlsSupabase() {
  const tabelas = [
    "matriculas_bloqueadas",
    "push_subscriptions",
    "tokens_recuperacao",
    "usuarios_favoritos",
    "anuncios",
    "contatos_motorista",
    "eventos_uso",
    "pedido_fila",
    "admin_chamados",
    "caronas",
    "pedidos",
    "propostas",
    "viagens",
    "viagem_pontos",
    "habilitacoes_motorista",
    "localizacoes_online",
    "usuarios",
    "contratos",
    "empresas",
    "projetos",
  ];
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
    await pool.query("UPDATE pedidos SET notificado = FALSE WHERE notificado IS NULL");
  } catch (e) {
    console.error("garantirColunasPedidos FALHOU — rode migrations/2026-07-08-pedidos-agendamento.sql no Supabase:", e.message);
  }
}

async function garantirColunasLocalizacao() {
  try {
    await pool.query("ALTER TABLE localizacoes_online ADD COLUMN IF NOT EXISTS online_desde TIMESTAMP");
    await pool.query("ALTER TABLE localizacoes_online ADD COLUMN IF NOT EXISTS vagas INTEGER DEFAULT 1");
    await corrigirInconsistenciasModoAmarelo();
  } catch (e) {
    console.warn("garantirColunasLocalizacao:", e.message);
  }
}

// Modo amarelo = online_desde preenchido. Não pode coexistir com carona ativa —
// senão o passageiro vê destino/rota fantasma. Limpa linhas inconsistentes no boot.
async function corrigirInconsistenciasModoAmarelo() {
  try {
    const { rowCount } = await pool.query(
      `UPDATE caronas SET status = 'cancelada'
       WHERE status = 'ativa'
         AND motorista_id IN (
           SELECT usuario_id FROM localizacoes_online
           WHERE disponivel = TRUE AND online_desde IS NOT NULL
         )`
    );
    if (rowCount > 0) {
      console.log(`Modo amarelo: cancelou ${rowCount} carona(s) ativa(s) inconsistente(s).`);
    }
  } catch (e) {
    console.warn("corrigirInconsistenciasModoAmarelo:", e.message);
  }
}

// Um motorista só pode ter 1 carona ativa. Histórico antigo preso com status
// 'ativa' duplicava cards na lista "Motoristas indo para lá".
async function garantirCaronasUnicasAtivas() {
  try {
    const { rowCount } = await pool.query(
      `UPDATE caronas SET status = 'cancelada'
       WHERE status = 'ativa'
         AND id NOT IN (
           SELECT DISTINCT ON (motorista_id) id
           FROM caronas
           WHERE status = 'ativa'
           ORDER BY motorista_id, created_at DESC
         )`
    );
    if (rowCount > 0) {
      console.log(`Caronas: cancelou ${rowCount} registro(s) ativo(s) duplicado(s).`);
    }
  } catch (e) {
    console.warn("garantirCaronasUnicasAtivas:", e.message);
  }
}

// Garante no banco: no máximo 1 publicação ativa por motorista.
async function garantirIndiceCaronaUnica() {
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_caronas_um_ativa_por_motorista
      ON caronas (motorista_id) WHERE status = 'ativa'
    `);
  } catch (e) {
    console.warn("garantirIndiceCaronaUnica:", e.message);
  }
}

// Motorista que sumiu de VEZ (GPS parado além do limite longo) sai do online.
// Sinal instável (< GPS_STALE_MIN) só some do mapa, sem perder a publicação.
async function limparLocalizacoesFantasma() {
  try {
    const { rowCount } = await pool.query(
      `UPDATE localizacoes_online SET disponivel = FALSE, online_desde = NULL
       WHERE disponivel = TRUE AND ${SQL_GPS_STALE}`
    );
    if (rowCount > 0) {
      console.log(`Online: desligou ${rowCount} motorista(s) com GPS parado há +${GPS_STALE_MIN} min.`);
    }
  } catch (e) {
    console.warn("limparLocalizacoesFantasma:", e.message);
  }
}

// Carona ativa cujo motorista sumiu de vez (sem GPS há +GPS_STALE_MIN, ou
// offline) vira card fantasma — ex.: Vale/Portaria S11D antigo no banco.
// Não cancela por instabilidade curta: enquanto o motorista pode voltar, a
// publicação fica no banco (só não aparece no mapa, pelo filtro FRESH).
async function limparCaronasOrfas() {
  try {
    const { rowCount } = await pool.query(
      `UPDATE caronas c SET status = 'cancelada'
       WHERE c.status = 'ativa'
         AND NOT EXISTS (
           SELECT 1 FROM localizacoes_online l
           WHERE l.usuario_id = c.motorista_id
             AND l.disponivel = TRUE
             AND NOT (${SQL_GPS_STALE.replace("atualizado_em", "l.atualizado_em")})
         )`
    );
    if (rowCount > 0) {
      console.log(`Caronas: cancelou ${rowCount} rota(s) ativa(s) sem motorista online.`);
    }
  } catch (e) {
    console.warn("limparCaronasOrfas:", e.message);
  }
}

// Limpeza operacional: só a publicação atual (GPS vivo) fica visível ao usuário.
// Histórico de viagens/rastreio permanece intacto.
async function limparPublicacoesFantasma() {
  await corrigirInconsistenciasModoAmarelo();
  await garantirCaronasUnicasAtivas();
  await limparLocalizacoesFantasma();
  await limparCaronasOrfas();
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

// Auto-heal: a viagem tem 2 fases — 'encontro' (motorista indo buscar) e
// 'destino' (a caminho do destino). Bancos antigos não têm a coluna.
async function garantirColunasViagens() {
  try {
    await pool.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS fase TEXT DEFAULT 'encontro'");
    await pool.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS deslocamento_valido BOOLEAN DEFAULT FALSE");
    await pool.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS embarque_em TIMESTAMP");
    await pool.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS km_maps NUMERIC(10,2)");
    await pool.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS km_tela NUMERIC(10,2)");
    await pool.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS km_fonte VARCHAR(20)");
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

async function garantirTabelaPedidoFila() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedido_fila (
        id SERIAL PRIMARY KEY,
        pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
        motorista_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        ordem INTEGER NOT NULL,
        dist_km NUMERIC(10,2),
        status VARCHAR(20) NOT NULL DEFAULT 'aguardando'
          CHECK (status IN ('aguardando','ofertada','aceita','recusada','expirada','cancelada')),
        ofertada_em TIMESTAMP,
        expira_em TIMESTAMP,
        respondida_em TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_pedido_fila_pedido ON pedido_fila(pedido_id, ordem)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_pedido_fila_motorista_ativa ON pedido_fila(motorista_id, status)");
  } catch (e) {
    console.warn("garantirTabelaPedidoFila:", e.message);
  }
}

async function garantirTabelaFavoritos() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios_favoritos (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        nome VARCHAR(200) NOT NULL,
        busca VARCHAR(300) NOT NULL,
        ref_lat NUMERIC(10,6),
        ref_lng NUMERIC(10,6),
        grupo VARCHAR(100),
        ordem INTEGER NOT NULL DEFAULT 0,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (usuario_id, nome)
      )`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_usuarios_favoritos_usuario ON usuarios_favoritos(usuario_id)");
  } catch (e) {
    console.warn("garantirTabelaFavoritos:", e.message);
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

// Horário vindo do cliente: datetime-local (horário de parede do canteiro, sem UTC).
// Protege contra iOS antigo mandando texto inválido.
function horarioValido(h) {
  if (!h) return null;
  // Date (ex.: coluna timestamp lida pelo node-pg): usa os componentes de parede
  // locais — String(Date) vira "... GMT-0300 (...)" e o Postgres recusa esse texto.
  if (h instanceof Date) {
    if (isNaN(h.getTime())) return null;
    const p = (n) => String(n).padStart(2, "0");
    return `${h.getFullYear()}-${p(h.getMonth() + 1)}-${p(h.getDate())} ${p(h.getHours())}:${p(h.getMinutes())}:${p(h.getSeconds())}`;
  }
  const s = String(h).trim();
  if (!s) return null;
  const local = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (local) return `${local[1]}-${local[2]}-${local[3]} ${local[4]}:${local[5]}:00`;
  if (!isNaN(Date.parse(s))) return s;
  return null;
}

async function pedidoAgendadoFuturo(horario) {
  const h = horarioValido(horario);
  if (!h) return false;
  const { rows } = await pool.query("SELECT ($1::timestamp > NOW()) AS futuro", [h]);
  return !!rows[0]?.futuro;
}

// Expressão Haversine (km) entre uma coluna (latCol/lngCol) e parâmetros $i/$j
const haversine = (latCol, lngCol, pLat, pLng) => `
  (6371 * acos(LEAST(1, GREATEST(-1,
    cos(radians(${pLat})) * cos(radians(${latCol})) * cos(radians(${lngCol}) - radians(${pLng}))
    + sin(radians(${pLat})) * sin(radians(${latCol}))
  ))))`;

// Distância (km) de um ponto até o SEGMENTO A→B (projeção equirretangular local).
function sqlSegmentoBase(latCol, lngCol, aLat, aLng, bLat, bLng) {
  const px = `((${lngCol}) - (${aLng})) * 111.320 * cos(radians(${aLat}))`;
  const py = `((${latCol}) - (${aLat})) * 110.574`;
  const bx = `((${bLng}) - (${aLng})) * 111.320 * cos(radians(${aLat}))`;
  const by = `((${bLat}) - (${aLat})) * 110.574`;
  const denom = `NULLIF((${bx})*(${bx}) + (${by})*(${by}), 0)`;
  return { px, py, bx, by, denom };
}

function sqlParametroSegmento(latCol, lngCol, aLat, aLng, bLat, bLng) {
  const { px, py, bx, by, denom } = sqlSegmentoBase(latCol, lngCol, aLat, aLng, bLat, bLng);
  return `COALESCE((( ${px} )*(${bx}) + ( ${py} )*(${by})) / ${denom}, 0)`;
}

function distanciaSegmentoKm(latCol, lngCol, aLat, aLng, bLat, bLng) {
  const { px, py, bx, by, denom } = sqlSegmentoBase(latCol, lngCol, aLat, aLng, bLat, bLng);
  const t = `LEAST(1, GREATEST(0, COALESCE((( ${px} )*(${bx}) + ( ${py} )*(${by})) / ${denom}, 0)))`;
  return `sqrt(POWER((${px}) - (${t})*(${bx}), 2) + POWER((${py}) - (${t})*(${by}), 2))`;
}

function sqlCorredorSegmento(latCol, lngCol, aLat, aLng, bLat, bLng, raioKm) {
  const { px, py, bx, by, denom } = sqlSegmentoBase(latCol, lngCol, aLat, aLng, bLat, bLng);
  const tRaw = sqlParametroSegmento(latCol, lngCol, aLat, aLng, bLat, bLng);
  const tClamp = `LEAST(1, GREATEST(0, ${tRaw}))`;
  const dist = `sqrt(POWER((${px}) - (${tClamp})*(${bx}), 2) + POWER((${py}) - (${tClamp})*(${by}), 2))`;
  return {
    t: tRaw,
    dist,
    noSegmento: `(${dist} <= ${raioKm} AND ${tRaw} >= 0 AND ${tRaw} <= 1)`,
    alemDestino: `(${dist} <= ${raioKm} AND ${tRaw} > 1)`,
  };
}

// Destino do passageiro no trajeto publicado: mesmo ponto OU entre origem e destino.
function sqlDestinoPassageiroNaCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const cor = sqlCorredorSegmento(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  const mesmo = `${haversine(carDestLat, carDestLng, pDestLat, pDestLng)} <= ${RAIO_MESMO_DEST_KM}`;
  return `(${mesmo} OR ${cor.noSegmento})`;
}

// Destino do passageiro além do fim da carona (mesma pista, motorista não vai até lá).
function sqlDestinoPassageiroAlemCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const cor = sqlCorredorSegmento(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  return cor.alemDestino;
}

// Compatibilidade total: embarque E desembarque dentro do segmento publicado.
function sqlPedidoCombinaComCarona(pOrigLat, pOrigLng, pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const destOk = sqlDestinoPassageiroNaCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng);
  const origCor = sqlCorredorSegmento(pOrigLat, pOrigLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  return `(${destOk} AND ${origCor.noSegmento})`;
}

// Parcial: passageiro quer ir além — só até o destino do motorista.
function sqlPedidoCombinaComCaronaParcial(pOrigLat, pOrigLng, pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const destParcial = sqlDestinoPassageiroAlemCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng);
  const origCor = sqlCorredorSegmento(pOrigLat, pOrigLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  return `(${destParcial} AND ${origCor.noSegmento})`;
}

// Próximo: destino do passageiro perto do destino da carona ou do corredor, mas não total/parcial.
function sqlDestinoProximoCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const total = sqlDestinoPassageiroNaCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng);
  const parcial = sqlDestinoPassageiroAlemCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng);
  const pertoDest = `${haversine(carDestLat, carDestLng, pDestLat, pDestLng)} <= ${RAIO_PROXIMO_KM}`;
  const corPax = sqlCorredorSegmento(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_PROXIMO_KM);
  const pertoCorredor = `(${corPax.dist} <= ${RAIO_PROXIMO_KM})`;
  return `(NOT (${total}) AND NOT (${parcial}) AND (${pertoDest} OR ${pertoCorredor}))`;
}

function sqlPedidoCombinaComCaronaProximo(pOrigLat, pOrigLng, pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const destProx = sqlDestinoProximoCarona(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng);
  const origCor = sqlCorredorSegmento(pOrigLat, pOrigLng, carOrigLat, carOrigLng, carDestLat, carDestLng, RAIO_ROTA_KM);
  return `(${destProx} AND ${origCor.noSegmento})`;
}

// Motorista "na pista": GPS na faixa da rota do passageiro OU carona publicada compatível.
function sqlMotoristaNaRotaPassageiro(pOrigLat, pOrigLng, pDestLat, pDestLng, gpsLatCol, gpsLngCol, motoristaIdCol) {
  const gpsNaFaixa = `${distanciaSegmentoKm(gpsLatCol, gpsLngCol, pOrigLat, pOrigLng, pDestLat, pDestLng)} <= ${RAIO_ROTA_KM}`;
  const caronaCompat = `EXISTS (
    SELECT 1 FROM caronas ca
    WHERE ca.motorista_id = ${motoristaIdCol}
      AND ca.status = 'ativa' AND ca.vagas > 0
      AND ca.origem_lat IS NOT NULL AND ca.destino_lat IS NOT NULL
      AND (
        ${sqlPedidoCombinaComCarona(pOrigLat, pOrigLng, pDestLat, pDestLng, "ca.origem_lat", "ca.origem_lng", "ca.destino_lat", "ca.destino_lng")}
        OR ${sqlPedidoCombinaComCaronaParcial(pOrigLat, pOrigLng, pDestLat, pDestLng, "ca.origem_lat", "ca.origem_lng", "ca.destino_lat", "ca.destino_lng")}
        OR ${sqlPedidoCombinaComCaronaProximo(pOrigLat, pOrigLng, pDestLat, pDestLng, "ca.origem_lat", "ca.origem_lng", "ca.destino_lat", "ca.destino_lng")}
      )
  )`;
  return `(${gpsNaFaixa} OR ${caronaCompat})`;
}

function corredorSegmentoKm(lat, lng, aLat, aLng, bLat, bLng) {
  const px = (lng - aLng) * 111.320 * Math.cos((aLat * Math.PI) / 180);
  const py = (lat - aLat) * 110.574;
  const bx = (bLng - aLng) * 111.320 * Math.cos((aLat * Math.PI) / 180);
  const by = (bLat - aLat) * 110.574;
  const denom = bx * bx + by * by;
  const tRaw = denom > 0 ? (px * bx + py * by) / denom : 0;
  const t = Math.min(1, Math.max(0, tRaw));
  const dist = Math.sqrt((px - t * bx) ** 2 + (py - t * by) ** 2);
  return { t: tRaw, dist };
}

function compatRotaPassageiro(pDestLat, pDestLng, carOrigLat, carOrigLng, carDestLat, carDestLng) {
  const dl = Number(pDestLat);
  const dg = Number(pDestLng);
  const oLat = Number(carOrigLat);
  const oLng = Number(carOrigLng);
  const dLat = Number(carDestLat);
  const dLng = Number(carDestLng);
  if (![dl, dg, oLat, oLng, dLat, dLng].every(Number.isFinite)) return "none";

  const mesmo = haversineKmCoord(dLat, dLng, dl, dg) <= RAIO_MESMO_DEST_KM;
  const cor = corredorSegmentoKm(dl, dg, oLat, oLng, dLat, dLng);
  if (mesmo || (cor.dist <= RAIO_ROTA_KM && cor.t >= 0 && cor.t <= 1)) return "total";
  if (cor.dist <= RAIO_ROTA_KM && cor.t > 1) return "parcial";

  const pertoDest = haversineKmCoord(dLat, dLng, dl, dg) <= RAIO_PROXIMO_KM;
  const pertoCor = cor.dist <= RAIO_PROXIMO_KM;
  if (pertoDest || pertoCor) return "proximo";
  return "none";
}

function haversineKmCoord(lat1, lng1, lat2, lng2) {
  const p1 = Number(lat1);
  const p2 = Number(lat2);
  const g1 = Number(lng1);
  const g2 = Number(lng2);
  if (![p1, p2, g1, g2].every(Number.isFinite)) return 0;
  const dLat = ((p2 - p1) * Math.PI) / 180;
  const dLng = ((g2 - g1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((p1 * Math.PI) / 180) * Math.cos((p2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcularKmGpsFromPontos(pontos) {
  if (!Array.isArray(pontos) || pontos.length < 2) {
    return { km: 0, valido: false, kmBruto: 0, segmentosValidos: 0, deslocamentoLinha: 0 };
  }
  let km = 0;
  let segmentosValidos = 0;
  for (let i = 1; i < pontos.length; i++) {
    const prev = pontos[i - 1];
    const cur = pontos[i];
    const seg = haversineKmCoord(prev.lat, prev.lng, cur.lat, cur.lng);
    const t0 = new Date(prev.registrado_em || prev.em || 0).getTime();
    const t1 = new Date(cur.registrado_em || cur.em || 0).getTime();
    const dtH = t1 > t0 ? (t1 - t0) / 3600000 : 0;
    if (dtH > 0 && seg / dtH > KM_VELOCIDADE_MAX_H) continue;
    if (seg < KM_SEGMENTO_MIN) continue;
    km += seg;
    segmentosValidos++;
  }
  const primeiro = pontos[0];
  const ultimo = pontos[pontos.length - 1];
  const deslocamentoLinha = haversineKmCoord(primeiro.lat, primeiro.lng, ultimo.lat, ultimo.lng);
  const kmArred = Math.round(km * 100) / 100;
  const valido = segmentosValidos >= 3
    && kmArred >= KM_MINIMO_VIAGEM
    && deslocamentoLinha >= KM_MINIMO_VIAGEM * 0.6;
  return {
    km: valido ? kmArred : 0,
    valido,
    kmBruto: kmArred,
    segmentosValidos,
    deslocamentoLinha: Math.round(deslocamentoLinha * 100) / 100,
  };
}

async function calcularKmGpsViagem(viagemId, opts = {}) {
  let sql = `SELECT lat::float8 AS lat, lng::float8 AS lng, registrado_em
     FROM viagem_pontos WHERE viagem_id = $1`;
  const params = [viagemId];
  if (opts.desde) {
    sql += ` AND registrado_em >= $2::timestamptz`;
    params.push(opts.desde);
  }
  sql += ` ORDER BY registrado_em`;
  const { rows } = await pool.query(sql, params);
  return calcularKmGpsFromPontos(rows);
}

function arredondarKm(km) {
  const n = Number(km);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100) / 100;
}

function parseKmMedicao(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0 || n > 2000) return 0;
  return n;
}

// Escolhe a melhor medição disponível (GPS pós-embarque, Maps ou km acumulado na tela).
function resolverKmMedicaoViagem(viagem, calcGps, kmMapsBody, kmTelaBody) {
  const maps = parseKmMedicao(kmMapsBody);
  const tela = parseKmMedicao(kmTelaBody);
  const candidatos = [];

  if (calcGps.kmBruto > 0) {
    candidatos.push({
      km: calcGps.valido ? calcGps.km : calcGps.kmBruto,
      valido: calcGps.valido,
      prio: 3,
      fonte: "gps",
    });
  }
  if (tela >= KM_MINIMO_VIAGEM) {
    candidatos.push({ km: tela, valido: true, prio: 2, fonte: "tela" });
  } else if (tela > 0) {
    candidatos.push({ km: tela, valido: false, prio: 1, fonte: "tela" });
  }
  if (maps >= KM_MINIMO_VIAGEM) {
    candidatos.push({ km: maps, valido: true, prio: 2, fonte: "maps" });
  } else if (maps > 0) {
    candidatos.push({ km: maps, valido: false, prio: 1, fonte: "maps" });
  }

  const valido = candidatos.filter((c) => c.valido).sort((a, b) => b.prio - a.prio)[0];
  if (valido) {
    return {
      km: arredondarKm(valido.km),
      valido: true,
      fonte: valido.fonte,
      km_maps: maps || null,
      km_tela: tela || null,
    };
  }

  const maior = [...candidatos].sort((a, b) => b.km - a.km)[0];
  if (maior && maior.km >= KM_MINIMO_VIAGEM * 0.4) {
    return {
      km: arredondarKm(maior.km),
      valido: maior.km >= KM_MINIMO_VIAGEM,
      fonte: maior.fonte,
      km_maps: maps || null,
      km_tela: tela || null,
    };
  }

  if (viagem?.embarque_em && viagem.destino_lat != null && viagem.origem_lat != null) {
    const linha = haversineKmCoord(
      +viagem.origem_lat, +viagem.origem_lng,
      +viagem.destino_lat, +viagem.destino_lng
    );
    if (linha >= KM_MINIMO_VIAGEM * 0.6) {
      return {
        km: arredondarKm(linha),
        valido: linha >= KM_MINIMO_VIAGEM,
        fonte: "linha",
        km_maps: maps || null,
        km_tela: tela || null,
      };
    }
  }

  return { km: 0, valido: false, fonte: null, km_maps: maps || null, km_tela: tela || null };
}

const sqlViagemKmValido = (alias = "v") => `${alias}.deslocamento_valido = TRUE`;

// Data da viagem no período: usa finalização; viagens antigas sem esse campo caem na data de início.
const sqlViagemNoPeriodo = (alias = "v") =>
  `COALESCE(${alias}.finalizada_em, ${alias}.iniciada_em) >= $2::timestamptz AND COALESCE(${alias}.finalizada_em, ${alias}.iniciada_em) < $3::timestamptz`;

function parseDataCalendario(str) {
  const m = String(str || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  return {
    y, mo, d,
    label: `${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}/${y}`,
  };
}

// 00:00 em Brasília (UTC-3) = 03:00 UTC no mesmo dia civil.
function inicioDiaBrUtc(ymd) {
  return new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d, 3, 0, 0, 0));
}

function fimDiaBrUtcExclusivo(ymd) {
  return new Date(Date.UTC(ymd.y, ymd.mo - 1, ymd.d + 1, 3, 0, 0, 0));
}

function hojeBrYmd() {
  const agoraBr = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return {
    y: agoraBr.getUTCFullYear(),
    mo: agoraBr.getUTCMonth() + 1,
    d: agoraBr.getUTCDate(),
  };
}

function periodoFromQuery(de, ate) {
  const hoje = hojeBrYmd();
  const deYmd = parseDataCalendario(de) || { ...hoje, mo: hoje.mo, d: 1, label: `01/${String(hoje.mo).padStart(2, "0")}/${hoje.y}` };
  const ateYmd = parseDataCalendario(ate) || {
    ...hoje,
    label: `${String(hoje.d).padStart(2, "0")}/${String(hoje.mo).padStart(2, "0")}/${hoje.y}`,
  };
  const inicio = inicioDiaBrUtc(deYmd);
  const fimExcl = fimDiaBrUtcExclusivo(ateYmd);
  if (isNaN(inicio.getTime()) || isNaN(fimExcl.getTime()) || fimExcl <= inicio) return null;
  return {
    de: inicio.toISOString(),
    ate: fimExcl.toISOString(),
    deLabel: deYmd.label,
    ateLabel: ateYmd.label,
  };
}

function numSeguro(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Notifica motoristas ONLINE (disponivel) dentro de RAIO_ONLINE_KM (600 m).
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
         SELECT DISTINCT ON (h.motorista_id) h.motorista_id,
                ${haversine("l.lat", "l.lng", "$1", "$2")} AS dist
         FROM habilitacoes_motorista h
         JOIN localizacoes_online l ON l.usuario_id = h.motorista_id AND l.disponivel = TRUE
         JOIN usuarios um ON um.id = h.motorista_id
         WHERE h.status = 'ativa' AND ${sqlSelfieValida("h")}
           AND h.motorista_id <> $3
           AND um.projeto_id = $5
           AND COALESCE(um.ativo, TRUE) = TRUE
         ORDER BY h.motorista_id, h.created_at DESC
       ) s
       WHERE s.dist <= $4
       ORDER BY s.dist ASC
       LIMIT 8`,
      [ped.origem_lat, ped.origem_lng, ped.passageiro_id, RAIO_ONLINE_KM, passInfo.projeto_id]
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

// Agendador: pedidos com horário marcado só entram no ar na hora marcada.
// Usa a mesma fila sequencial do pedido imediato (usar_fila), não só push 600 m.
async function ativarPedidoAgendado(ped) {
  try {
    await iniciarFilaPedido(ped.id);
    await pool.query("UPDATE pedidos SET notificado = TRUE WHERE id = $1", [ped.id]);
    const destino = ped.destino_texto ? ` para ${ped.destino_texto}` : "";
    enviarPush(ped.passageiro_id, {
      title: "Horário da sua carona",
      body: `Seu pedido agendado entrou no ar${destino}. Procurando motoristas.`,
      url: "/dashboard.html",
    });
  } catch (e) {
    console.warn("ativarPedidoAgendado:", e.message);
  }
}

setInterval(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM pedidos
      WHERE status = 'aberto' AND COALESCE(notificado, FALSE) = FALSE
        AND horario IS NOT NULL AND horario <= NOW()
    `);
    await Promise.all(rows.map(ativarPedidoAgendado));
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

// Cancela rotas publicadas cujo motorista saiu do ar (evita cards antigos na lista).
setInterval(() => {
  limparPublicacoesFantasma().catch((err) => console.error("Erro ao limpar publicações fantasma:", err.message));
}, 5 * 60 * 1000);

// Fila de chamada sequencial (pedido por rota): avança pro próximo motorista
// quando o da vez estoura o prazo sem responder (ver FILA_OFERTA_TIMEOUT_S).
setInterval(() => {
  expirarFilasVencidas().catch((err) => console.error("Erro ao expirar filas:", err.message));
}, FILA_TICK_MS);

// Retenção de fotos de segurança: apaga do Storage após 30 dias.
setInterval(() => { aplicarRetencaoFotos().catch((e) => console.warn("retencao:", e.message)); }, 24 * 60 * 60 * 1000);
setTimeout(() => { aplicarRetencaoFotos().catch(() => {}); }, 60 * 1000);

/* ============================ CONFIG ============================ */
app.get("/api/config", (req, res) => {
  res.json({
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "",
    mapsMapId: process.env.GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID",
    pushPublicKey: VAPID_PUBLIC,
  });
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
    invalidarProjetoCache(req.user.id);
    const userFront = await buscarUsuarioFront(req.user.id);
    res.json(userFront);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar perfil" });
  }
});

function normalizarFavoritoItem(item) {
  const nome = String(item?.nome || "").trim().slice(0, 200);
  const busca = String(item?.busca || nome).trim().slice(0, 300);
  if (!nome || !busca) return null;
  const ref = item?.ref;
  let ref_lat = null;
  let ref_lng = null;
  if (ref && Number.isFinite(Number(ref.lat)) && Number.isFinite(Number(ref.lng))) {
    ref_lat = Number(ref.lat);
    ref_lng = Number(ref.lng);
  }
  const grupo = String(item?.grupo || "").trim().slice(0, 100) || null;
  return { nome, busca, ref_lat, ref_lng, grupo };
}

app.get("/api/perfil/favoritos", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT nome, busca, ref_lat, ref_lng, grupo, ordem
       FROM usuarios_favoritos WHERE usuario_id = $1 ORDER BY ordem ASC, nome ASC`,
      [req.user.id]
    );
    res.json(rows.map((r) => ({
      nome: r.nome,
      busca: r.busca,
      grupo: r.grupo || undefined,
      ref: r.ref_lat != null && r.ref_lng != null ? { lat: Number(r.ref_lat), lng: Number(r.ref_lng) } : undefined,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao carregar favoritos" });
  }
});

app.put("/api/perfil/favoritos", verificarAuth, async (req, res) => {
  const lista = Array.isArray(req.body?.favoritos) ? req.body.favoritos : null;
  if (!lista) return res.status(400).json({ error: "Lista de favoritos inválida" });
  if (lista.length > 40) return res.status(400).json({ error: "Máximo de 40 favoritos" });
  const normalizados = [];
  const vistos = new Set();
  for (const item of lista) {
    const f = normalizarFavoritoItem(item);
    if (!f || vistos.has(f.nome)) continue;
    vistos.add(f.nome);
    normalizados.push(f);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM usuarios_favoritos WHERE usuario_id = $1", [req.user.id]);
    for (let i = 0; i < normalizados.length; i++) {
      const f = normalizados[i];
      await client.query(
        `INSERT INTO usuarios_favoritos (usuario_id, nome, busca, ref_lat, ref_lng, grupo, ordem)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.user.id, f.nome, f.busca, f.ref_lat, f.ref_lng, f.grupo, i]
      );
    }
    await client.query("COMMIT");
    res.json(normalizados.map((f) => ({
      nome: f.nome,
      busca: f.busca,
      grupo: f.grupo || undefined,
      ref: f.ref_lat != null ? { lat: f.ref_lat, lng: f.ref_lng } : undefined,
    })));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Erro ao salvar favoritos" });
  } finally {
    client.release();
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
  // iOS/Safari pode demorar para gerar o JPEG/abrir GPS e alguns aparelhos ficam
  // com o relógio levemente adiantado. Mantém a exigência de captura ao vivo,
  // mas evita falso "expirada" por lentidão ou pequeno desvio de relógio.
  const FOTO_MAX_IDADE_MS = 10 * 60 * 1000;
  const FOTO_MAX_RELOGIO_ADIANTADO_MS = 5 * 60 * 1000;
  if (diffMs < -FOTO_MAX_RELOGIO_ADIANTADO_MS || diffMs > FOTO_MAX_IDADE_MS) {
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

    await pool.query(
      "UPDATE caronas SET status = 'cancelada' WHERE motorista_id = $1 AND status = 'ativa'",
      [req.user.id]
    );

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
      destFiltro = `AND (${compatTotal} OR ${compatParcial} OR ${compatProximo}) AND c.vagas > 0`;
      compatSel = `, CASE WHEN ${compatTotal} THEN 'total' WHEN ${compatParcial} THEN 'parcial' WHEN ${compatProximo} THEN 'proximo' ELSE 'none' END AS compat_rota`;
    } else if (temPos) {
      params.push(RAIO_VISIVEL_KM);
      origemRaio = `AND ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} <= $${params.length}`;
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
    usar_fila,
  } = req.body;
  const nPessoas = Math.min(Math.max(parseInt(pessoas, 10) || 1, 1), 6);

  if (origem_lat == null || origem_lng == null || destino_lat == null || destino_lng == null) {
    return res.status(400).json({ error: "Origem e destino são obrigatórios" });
  }
  if (!selfie_url) return res.status(400).json({ error: "Selfie é obrigatória para pedir carona" });

  try {
    const pid = await exigirProjeto(req.user.id, res);
    if (!pid) return;

    // Pedido imediato cancela só os "ao vivo" (sem horário futuro pendente).
    // Agendamentos futuros continuam válidos — o passageiro pode pedir outra carona agora.
    const hValido = horarioValido(horario);
    let agendadoNovo = false;
    if (hValido) {
      const { rows: chkNovo } = await pool.query(
        "SELECT ($1::timestamp > NOW()) AS futuro", [hValido]
      );
      agendadoNovo = !!chkNovo[0]?.futuro;
    }
    if (agendadoNovo) {
      await pool.query(
        `UPDATE pedidos SET status = 'cancelado'
         WHERE passageiro_id = $1 AND status = 'aberto'
           AND (horario IS NULL OR horario <= NOW())`,
        [req.user.id]
      );
    } else {
      await pool.query(
        `UPDATE pedidos SET status = 'cancelado'
         WHERE passageiro_id = $1 AND status = 'aberto'
           AND (horario IS NULL OR horario <= NOW() OR COALESCE(notificado, FALSE) = TRUE)`,
        [req.user.id]
      );
    }
    const { rows } = await pool.query(
      `INSERT INTO pedidos
         (passageiro_id, origem_texto, origem_lat, origem_lng,
          destino_texto, destino_lat, destino_lng, horario, observacao, pessoas,
          selfie_url, selfie_lat, selfie_lng, selfie_em, notificado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,FALSE)
       RETURNING *, (horario IS NOT NULL AND horario > NOW()) AS agendado_futuro`,
      [
        req.user.id, origem_texto || null, origem_lat, origem_lng,
        destino_texto || null, destino_lat, destino_lng, hValido, observacao || null, nPessoas,
        selfie_url, selfie_lat || null, selfie_lng || null, selfie_em || new Date(),
      ]
    );
    const ped = rows[0];
    // Decisão do agendamento feita no próprio banco (mesmo fuso da sessão, SET TIME
    // ZONE no connect). Antes isto passava a Date do node-pg de volta por
    // horarioValido() e o Postgres rejeitava a string "GMT..." (erro 500 ao agendar).
    const agendadoFuturo = !!ped.agendado_futuro;
    res.json(ped);

    // Pedido "para agora" (sem horário ou horário já vencido): notifica os motoristas
    // perto na hora. Pedido AGENDADO (horário futuro): não notifica agora — o agendador
    // dispara a notificação na hora marcada (notificado continua FALSE até lá).
    if (!agendadoFuturo) {
      // usar_fila: chama os motoristas da rota um de cada vez (mais perto
      // primeiro), em vez do broadcast pra todo mundo dentro de 600 m.
      if (usar_fila) await iniciarFilaPedido(ped.id);
      else await notificarMotoristasProximos(ped);
    }
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
      const params = [lat, lng, RAIO_ONLINE_KM];
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
      const caronaMot = (await pool.query(
        `SELECT origem_lat, origem_lng, destino_lat, destino_lng, destino_texto
         FROM caronas WHERE motorista_id = $1 AND status = 'ativa'
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.id]
      )).rows[0];
      const enriquecido = rows.map((p) => {
        if (!caronaMot?.destino_lat || p.destino_lat == null) return p;
        const compat = compatRotaPassageiro(
          p.destino_lat, p.destino_lng,
          caronaMot.origem_lat, caronaMot.origem_lng,
          caronaMot.destino_lat, caronaMot.destino_lng
        );
        return {
          ...p,
          compat_rota: compat,
          destino_motorista_texto: caronaMot.destino_texto,
        };
      });
      return res.json(enriquecido);
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

// Editar agendamento futuro (horário / pessoas) antes de entrar no ar.
app.patch("/api/pedidos/:id", verificarAuth, async (req, res) => {
  const { horario, pessoas } = req.body || {};
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Pedido inválido" });
  try {
    const atual = (await pool.query(
      "SELECT * FROM pedidos WHERE id = $1 AND passageiro_id = $2 AND status = 'aberto'",
      [id, req.user.id]
    )).rows[0];
    if (!atual) return res.status(404).json({ error: "Pedido não encontrado" });
    const { rows: chk } = await pool.query(
      `SELECT (horario IS NOT NULL AND horario > NOW()) AS futuro,
              COALESCE(notificado, FALSE) AS notificado
       FROM pedidos WHERE id = $1`,
      [id]
    );
    if (!chk[0]?.futuro || chk[0].notificado) {
      return res.status(400).json({
        error: "Só é possível editar agendamentos futuros que ainda não entraram no ar.",
      });
    }
    const hNovo = horario !== undefined ? horarioValido(horario) : atual.horario;
    if (horario !== undefined && horario && !hNovo) {
      return res.status(400).json({ error: "Horário inválido" });
    }
    if (hNovo) {
      const { rows: fut } = await pool.query(
        "SELECT ($1::timestamp > NOW()) AS ok", [hNovo]
      );
      if (!fut[0]?.ok) return res.status(400).json({ error: "Escolha um horário futuro" });
    }
    const nPessoas = pessoas !== undefined
      ? Math.min(Math.max(parseInt(pessoas, 10) || 1, 1), 6)
      : atual.pessoas;
    const { rows } = await pool.query(
      `UPDATE pedidos SET horario = $1, pessoas = $2, notificado = FALSE
       WHERE id = $3
       RETURNING *, (horario IS NOT NULL AND horario > NOW()) AS agendado_futuro`,
      [hNovo, nPessoas, id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar pedido" });
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

    const combinaRota = sqlPedidoCombinaComCarona("$1", "$2", "$3", "$4", "c.origem_lat", "c.origem_lng", "c.destino_lat", "c.destino_lng");
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT c.*, u.nome AS motorista_nome, h.placa, h.tag, h.foto_carro_url,
                ${haversine("c.origem_lat", "c.origem_lng", "$1", "$2")} AS dist_origem,
                ${haversine("c.destino_lat", "c.destino_lng", "$3", "$4")} AS dist_destino
         FROM caronas c
         JOIN usuarios u ON c.motorista_id = u.id
         LEFT JOIN habilitacoes_motorista h ON c.habilitacao_id = h.id
         JOIN localizacoes_online lo ON lo.usuario_id = c.motorista_id
           AND lo.disponivel = TRUE
           AND ${SQL_GPS_FRESH.replace("atualizado_em", "lo.atualizado_em")}
         WHERE c.status = 'ativa' AND c.motorista_id <> $5
           AND u.projeto_id = $7
           AND COALESCE(u.ativo, TRUE) = TRUE
           AND c.vagas > 0
           AND (c.horario IS NULL OR $6::timestamp IS NULL
                OR ABS(EXTRACT(EPOCH FROM (c.horario - $6::timestamp))) <= 3600)
       ) s
       WHERE ${combinaRota.replace(/c\./g, "s.")}
       ORDER BY (s.dist_origem + s.dist_destino) ASC
       LIMIT 20`,
      [ped.origem_lat, ped.origem_lng, ped.destino_lat, ped.destino_lng, req.user.id, ped.horario, pid]
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

    const combinaRota = sqlPedidoCombinaComCarona("p.origem_lat", "p.origem_lng", "p.destino_lat", "p.destino_lng", "$1", "$2", "$3", "$4");
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT p.*, u.nome AS passageiro_nome,
                ${haversine("p.origem_lat", "p.origem_lng", "$1", "$2")} AS dist_origem,
                ${haversine("p.destino_lat", "p.destino_lng", "$3", "$4")} AS dist_destino
         FROM pedidos p
         JOIN usuarios u ON p.passageiro_id = u.id
         WHERE p.status = 'aberto' AND p.passageiro_id <> $5
           AND u.projeto_id = $7
           AND COALESCE(u.ativo, TRUE) = TRUE
           AND (p.horario IS NULL OR $6::timestamp IS NULL
                OR ABS(EXTRACT(EPOCH FROM (p.horario - $6::timestamp))) <= 3600)
       ) s
       WHERE ${combinaRota.replace(/p\./g, "s.")}
       ORDER BY (s.dist_origem + s.dist_destino) ASC
       LIMIT 20`,
      [car.origem_lat, car.origem_lng, car.destino_lat, car.destino_lng, req.user.id, car.horario, pid]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar pedidos" });
  }
});

/* ============================ PROPOSTAS ============================ */
app.post("/api/propostas", verificarAuth, async (req, res) => {
  const { carona_id, pedido_id, contato_id, mensagem, selfie_url, selfie_lat, selfie_lng, selfie_em, pessoas } = req.body;
  if (!carona_id && !pedido_id && !contato_id) return res.status(400).json({ error: "Informe carona_id, pedido_id ou contato_id" });

  try {
    let para_usuario_id, dadosSelfie = {};
    const npessoas = Math.min(6, Math.max(parseInt(pessoas, 10) || 1, 1));

    if (carona_id) {
      // Passageiro pedindo uma vaga numa carona -> precisa de selfie
      if (!selfie_url) return res.status(400).json({ error: "Selfie é obrigatória para pedir vaga" });
      const car = (await pool.query("SELECT * FROM caronas WHERE id = $1 AND status = 'ativa'", [carona_id])).rows[0];
      if (!car) return res.status(404).json({ error: "Carona indisponível" });
      if (car.motorista_id === req.user.id) return res.status(400).json({ error: "Você é o motorista desta carona" });
      if (!(await validarMesmoProjeto(req.user.id, car.motorista_id, res))) return;
      if ((car.vagas || 0) < npessoas) {
        return res.status(400).json({
          error: npessoas === 1
            ? "Não há vagas disponíveis nesta carona"
            : `Só há ${car.vagas} vaga(s) — você pediu ${npessoas}.`,
        });
      }
      para_usuario_id = car.motorista_id;
      dadosSelfie = { selfie_url, selfie_lat, selfie_lng, selfie_em: selfie_em || new Date() };
    } else if (contato_id) {
      const hab = await habilitacaoAtiva(req.user.id);
      if (!hab) return res.status(403).json({ error: "Ative o modo motorista antes de oferecer carona" });
      const cont = (await pool.query(
        "SELECT * FROM contatos_motorista WHERE id = $1 AND motorista_id = $2",
        [contato_id, req.user.id]
      )).rows[0];
      if (!cont) return res.status(404).json({ error: "Contato indisponível" });
      if (!(await validarMesmoProjeto(req.user.id, cont.passageiro_id, res))) return;
      para_usuario_id = cont.passageiro_id;
      await pool.query("UPDATE contatos_motorista SET lido = TRUE WHERE id = $1", [contato_id]);
      await pool.query(
        `UPDATE contatos_motorista SET lido = TRUE
         WHERE motorista_id = $1 AND passageiro_id = $2 AND lido = FALSE`,
        [req.user.id, cont.passageiro_id]
      );
    } else {
      // Motorista oferecendo carona a um pedido -> precisa de habilitação ativa
      const hab = await habilitacaoAtiva(req.user.id);
      if (!hab) return res.status(403).json({ error: "Ative o modo motorista antes de oferecer carona" });
      const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1 AND status = 'aberto'", [pedido_id])).rows[0];
      if (!ped) return res.status(404).json({ error: "Pedido indisponível" });
      if (ped.passageiro_id === req.user.id) return res.status(400).json({ error: "Este pedido é seu" });
      if (!(await validarMesmoProjeto(req.user.id, ped.passageiro_id, res))) return;
      // Pedido com fila ativa (chamada sequencial por rota): só quem está na
      // vez pode responder, e é pelos endpoints /api/pedido-fila/:id — evita
      // dois motoristas aceitando o mesmo pedido ao mesmo tempo.
      const temFila = (await pool.query("SELECT 1 FROM pedido_fila WHERE pedido_id = $1 LIMIT 1", [pedido_id])).rows[0];
      if (temFila) return res.status(400).json({ error: "Este pedido está usando busca automática por proximidade" });
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
      body: contato_id
        ? `${deNome} ofereceu uma carona para você.`
        : (carona_id ? `${deNome} pediu uma vaga na sua carona.` : `${deNome} ofereceu uma carona para você.`),
      url: "/dashboard.html",
      action: "nova_solicitacao",
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
  // Cada aceite ocupa 1 vaga. A carona só fecha (concluida) quando as vagas
  // acabam — com mais de uma vaga, ela continua ativa e visível para os
  // demais passageiros até esgotar.
  if (pr.carona_id) {
    await pool.query(
      `UPDATE caronas
       SET vagas = GREATEST(vagas - 1, 0),
           status = CASE WHEN vagas - 1 <= 0 THEN 'concluida' ELSE status END
       WHERE id = $1`,
      [pr.carona_id]
    );
  }
  if (pr.pedido_id) await pool.query("UPDATE pedidos SET status = 'atendido' WHERE id = $1", [pr.pedido_id]);
  return rows[0];
}

// Desfaz carona/pedido quando uma viagem em andamento é cancelada ou encerrada à força.
async function reverterRecursosDaViagem(v) {
  if (!v) return;
  if (v.carona_id) {
    const car = (await pool.query("SELECT motorista_id FROM caronas WHERE id = $1", [v.carona_id])).rows[0];
    if (car && await motoristaGpsVivo(car.motorista_id)) {
      await pool.query(
        `UPDATE caronas
         SET vagas = LEAST(vagas + 1, 6),
             status = CASE WHEN status IN ('concluida', 'cancelada') THEN 'ativa' ELSE status END
         WHERE id = $1`,
        [v.carona_id]
      );
    } else {
      await pool.query(
        "UPDATE caronas SET status = 'cancelada' WHERE id = $1 AND status = 'ativa'",
        [v.carona_id]
      );
    }
  }
  if (v.pedido_id) {
    await pool.query(
      "UPDATE pedidos SET status = 'aberto' WHERE id = $1 AND status <> 'cancelado'",
      [v.pedido_id]
    );
  }
}

async function cancelarViagemAtiva(viagemId, usuarioId) {
  const v = (await pool.query(
    "SELECT * FROM viagens WHERE id = $1 AND status = 'em_andamento'",
    [viagemId]
  )).rows[0];
  if (!v) return { ok: false, status: 404, error: "Viagem não encontrada ou já encerrada" };
  if (![v.motorista_id, v.passageiro_id].includes(usuarioId)) {
    return { ok: false, status: 403, error: "Sem permissão" };
  }
  const { rows } = await pool.query(
    `UPDATE viagens SET status = 'cancelada', finalizada_em = COALESCE(finalizada_em, NOW())
     WHERE id = $1 AND status = 'em_andamento' RETURNING *`,
    [viagemId]
  );
  if (!rows[0]) return { ok: false, status: 404, error: "Viagem não encontrada ou já encerrada" };
  await reverterRecursosDaViagem(v);
  return { ok: true, viagem: rows[0] };
}

/* ==================== FILA DE CHAMADA SEQUENCIAL (pedido por rota) ====================
 * Passageiro escolhe uma rota (origem->destino); todo motorista habilitado e
 * disponível "na pista" (dentro de RAIO_ROTA_KM da linha reta) entra numa fila
 * ordenada do mais perto pro mais longe. Só o motorista da vez recebe a oferta
 * (buzina); se recusar ou estourar o tempo (FILA_OFERTA_TIMEOUT_S), passa pro
 * próximo. Quem aceitar primeiro trava a vaga — os demais somem da fila.
 */

// Motoristas habilitados e disponíveis dentro de RAIO_ROTA_KM da rota
// origem->destino, ordenados do mais perto da ORIGEM pro mais longe.
async function motoristasNaRota(origem, destino, projetoId, excluirUsuarioId) {
  const distOrigem = haversine("l.lat", "l.lng", "$1", "$2");
  const naPista = sqlMotoristaNaRotaPassageiro("$1", "$2", "$3", "$4", "l.lat", "l.lng", "u.id");
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (u.id) u.id AS motorista_id, ${distOrigem} AS dist_km
     FROM localizacoes_online l
     JOIN usuarios u ON u.id = l.usuario_id
     JOIN habilitacoes_motorista h
       ON h.motorista_id = u.id AND h.status = 'ativa' AND ${sqlSelfieValida("h")}
     LEFT JOIN LATERAL (
       SELECT vagas FROM caronas WHERE motorista_id = u.id AND status = 'ativa'
       ORDER BY created_at DESC LIMIT 1
     ) ca ON TRUE
     WHERE l.disponivel = TRUE
       AND COALESCE(u.ativo, TRUE) = TRUE
       AND u.id <> $5
       AND u.projeto_id = $6
       AND (ca.vagas IS NULL OR ca.vagas > 0)
       AND ${naPista}
     ORDER BY u.id, h.created_at DESC`,
    [origem.lat, origem.lng, destino.lat, destino.lng, excluirUsuarioId, projetoId]
  );
  rows.sort((a, b) => Number(a.dist_km) - Number(b.dist_km));
  return rows;
}

// Cria a fila do pedido (uma vez) e oferta ao primeiro (mais perto).
async function iniciarFilaPedido(pedidoId) {
  const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1", [pedidoId])).rows[0];
  if (!ped) return;
  const pid = await projetoDoUsuario(ped.passageiro_id);
  if (!pid) return;
  const candidatos = await motoristasNaRota(
    { lat: ped.origem_lat, lng: ped.origem_lng },
    { lat: ped.destino_lat, lng: ped.destino_lng },
    pid, ped.passageiro_id
  );
  if (!candidatos.length) return;
  const values = candidatos.map((c, i) => `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`).join(",");
  const params = [pedidoId];
  candidatos.forEach((c, i) => params.push(c.motorista_id, i, c.dist_km));
  await pool.query(
    `INSERT INTO pedido_fila (pedido_id, motorista_id, ordem, dist_km) VALUES ${values}`,
    params
  );
  await ofertarProximo(pedidoId);
}

// Pega o próximo candidato "aguardando" (menor ordem) e oferta só pra ele.
async function ofertarProximo(pedidoId) {
  const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1", [pedidoId])).rows[0];
  if (!ped || ped.status !== "aberto") return;
  const proximo = (await pool.query(
    `SELECT * FROM pedido_fila WHERE pedido_id = $1 AND status = 'aguardando' ORDER BY ordem ASC LIMIT 1`,
    [pedidoId]
  )).rows[0];
  if (!proximo) return;
  await pool.query(
    `UPDATE pedido_fila SET status = 'ofertada', ofertada_em = NOW(),
            expira_em = NOW() + ($2 || ' seconds')::interval
     WHERE id = $1`,
    [proximo.id, String(FILA_OFERTA_TIMEOUT_S)]
  );
  enviarPush(proximo.motorista_id, {
    title: "Carona pedida perto de você",
    body: `Passageiro pedindo carona${ped.destino_texto ? ` para ${ped.destino_texto}` : ""}. Você é o mais perto — responda rápido.`,
    url: "/dashboard.html",
    action: "nova_oferta_fila",
  });
}

// Avançador de fundo: ofertas vencidas (motorista não respondeu a tempo) expiram
// e a fila passa pro próximo automaticamente.
async function expirarFilasVencidas() {
  const { rows } = await pool.query(
    `UPDATE pedido_fila SET status = 'expirada'
     WHERE status = 'ofertada' AND expira_em < NOW()
     RETURNING pedido_id`
  );
  const pedidoIds = [...new Set(rows.map((r) => r.pedido_id))];
  await Promise.all(pedidoIds.map((id) => ofertarProximo(id).catch((e) => console.warn("expirarFilasVencidas:", e.message))));
}

// Motorista consulta a oferta ativa dele na fila (se houver), com dados do
// pedido e o prazo pra responder — alimenta o cronômetro no app.
app.get("/api/motorista/oferta-atual", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.ordem, f.dist_km, f.ofertada_em, f.expira_em,
              p.id AS pedido_id, p.origem_texto, p.origem_lat, p.origem_lng,
              p.destino_texto, p.destino_lat, p.destino_lng, p.pessoas, p.observacao,
              u.nome AS passageiro_nome
       FROM pedido_fila f
       JOIN pedidos p ON p.id = f.pedido_id
       JOIN usuarios u ON u.id = p.passageiro_id
       WHERE f.motorista_id = $1 AND f.status = 'ofertada' AND p.status = 'aberto'
       ORDER BY f.ofertada_em DESC LIMIT 1`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao consultar oferta" });
  }
});

// Motorista aceita a oferta da fila: cria a proposta (já aceita) + a viagem
// reaproveitando o mesmo caminho de sempre, e trava as demais posições da fila.
app.post("/api/pedido-fila/:id/aceitar", verificarAuth, async (req, res) => {
  try {
    const oferta = (await pool.query(
      `UPDATE pedido_fila SET status = 'aceita', respondida_em = NOW()
       WHERE id = $1 AND motorista_id = $2 AND status = 'ofertada' AND expira_em > NOW()
       RETURNING *`,
      [req.params.id, req.user.id]
    )).rows[0];
    if (!oferta) return res.status(404).json({ error: "Oferta não encontrada, expirada ou já respondida" });

    const ped = (await pool.query("SELECT * FROM pedidos WHERE id = $1 AND status = 'aberto'", [oferta.pedido_id])).rows[0];
    if (!ped) return res.status(404).json({ error: "Pedido não está mais disponível" });

    const proposta = (await pool.query(
      `INSERT INTO propostas (de_usuario_id, para_usuario_id, pedido_id, status)
       VALUES ($1, $2, $3, 'aceito') RETURNING *`,
      [req.user.id, ped.passageiro_id, ped.id]
    )).rows[0];
    const viagem = await criarViagemDaProposta(proposta.id);
    if (!viagem) return res.status(500).json({ error: "Não foi possível iniciar a viagem. Tente novamente." });

    // Trava: ninguém mais da fila pode aceitar este pedido.
    await pool.query(
      `UPDATE pedido_fila SET status = 'cancelada'
       WHERE pedido_id = $1 AND id <> $2 AND status IN ('aguardando', 'ofertada')`,
      [oferta.pedido_id, oferta.id]
    );

    res.json({ proposta_id: proposta.id, viagem_id: viagem.id });

    enviarPush(ped.passageiro_id, {
      title: "Carona confirmada!",
      body: "Um motorista aceitou sua solicitação. Toque para acompanhar ao vivo.",
      url: "/dashboard.html",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao aceitar oferta" });
  }
});

// Motorista recusa: some da fila dele e a oferta passa pro próximo mais perto na hora.
app.post("/api/pedido-fila/:id/recusar", verificarAuth, async (req, res) => {
  try {
    const oferta = (await pool.query(
      `UPDATE pedido_fila SET status = 'recusada', respondida_em = NOW()
       WHERE id = $1 AND motorista_id = $2 AND status = 'ofertada'
       RETURNING *`,
      [req.params.id, req.user.id]
    )).rows[0];
    if (!oferta) return res.status(404).json({ error: "Oferta não encontrada ou já respondida" });
    await ofertarProximo(oferta.pedido_id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao recusar oferta" });
  }
});

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
    if (!viagem) {
      console.error("[aceitar proposta] viagem não criada para proposta", req.params.id);
      return res.status(500).json({ error: "Não foi possível iniciar a viagem. Tente novamente." });
    }
    res.json({ ...rows[0], viagem_id: viagem.id });

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
    // Permite cancelar uma proposta PENDENTE (chamada em espera) ou ACEITA — mas,
    // nesse caso, só ANTES do embarque (viagem ainda na fase 'encontro', motorista
    // a caminho de buscar). Depois que o motorista confirma o embarque (fase
    // 'destino', POST /api/viagens/:id/iniciar) não dá mais pra cancelar por aqui.
    // Vale para quem enviou ou recebeu. Guarda o status ANTERIOR (numa CTE,
    // atômico com o UPDATE) para saber se uma vaga/viagem precisa ser desfeita.
    const pr = (await pool.query(
      `WITH alvo AS (
         SELECT * FROM propostas
         WHERE id = $1 AND (de_usuario_id = $2 OR para_usuario_id = $2)
           AND status IN ('pendente', 'aceito')
           AND NOT EXISTS (
             SELECT 1 FROM viagens v
             WHERE v.proposta_id = propostas.id AND v.status = 'em_andamento' AND v.fase = 'destino'
           )
         FOR UPDATE
       ),
       atualizado AS (
         UPDATE propostas SET status = 'recusado'
         WHERE id = (SELECT id FROM alvo)
         RETURNING *
       )
       SELECT atualizado.*, alvo.status AS status_anterior
       FROM atualizado JOIN alvo ON alvo.id = atualizado.id`,
      [req.params.id, req.user.id]
    )).rows[0];
    if (!pr) return res.status(400).json({ error: "Não é possível cancelar (viagem já iniciada ou proposta inválida)" });

    // Proposta já tinha virado viagem (fase 'encontro', motorista ainda a
    // caminho): desfaz a viagem também, senão fica um "em_andamento" órfão.
    if (pr.status_anterior === "aceito") {
      await pool.query(
        "UPDATE viagens SET status = 'cancelada', finalizada_em = COALESCE(finalizada_em, NOW()) WHERE proposta_id = $1 AND status = 'em_andamento'",
        [pr.id]
      );
      const v = (await pool.query("SELECT * FROM viagens WHERE proposta_id = $1 ORDER BY id DESC LIMIT 1", [pr.id])).rows[0];
      if (v) await reverterRecursosDaViagem(v);
    }

    // Reabre a carona/pedido para que possam ser oferecidos de novo. Se a
    // proposta JÁ estava aceita, ela tinha ocupado 1 vaga (ver
    // criarViagemDaProposta) — devolve essa vaga agora.
    if (pr.carona_id) {
      const car = (await pool.query("SELECT motorista_id FROM caronas WHERE id = $1", [pr.carona_id])).rows[0];
      if (car && await motoristaGpsVivo(car.motorista_id)) {
        if (pr.status_anterior === "aceito") {
          await pool.query(
            "UPDATE caronas SET vagas = vagas + 1, status = 'ativa' WHERE id = $1 AND status <> 'cancelada'",
            [pr.carona_id]
          );
        } else {
          await pool.query("UPDATE caronas SET status = 'ativa' WHERE id = $1 AND status <> 'cancelada'", [pr.carona_id]);
        }
      } else {
        await pool.query(
          "UPDATE caronas SET status = 'cancelada' WHERE id = $1 AND status = 'ativa'",
          [pr.carona_id]
        );
      }
    }
    if (pr.pedido_id) {
      await pool.query("UPDATE pedidos SET status = 'aberto' WHERE id = $1 AND status <> 'cancelado'", [pr.pedido_id]);
      // Pedido com fila ativa: quem cancelou libera a vaga. O aceite tinha
      // travado (cancelado) o resto da fila — reabre essas posições e chama
      // o próximo mais perto na hora, sem esperar o passageiro agir de novo.
      const temFila = (await pool.query("SELECT 1 FROM pedido_fila WHERE pedido_id = $1 LIMIT 1", [pr.pedido_id])).rows[0];
      if (temFila) {
        await pool.query(
          "UPDATE pedido_fila SET status = 'aguardando' WHERE pedido_id = $1 AND status = 'cancelada'",
          [pr.pedido_id]
        );
        await ofertarProximo(pr.pedido_id);
      }
    }

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
    const agora = Date.now();
    pontos.slice(0, 500).forEach((p, i) => {
      const base = i * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(req.params.id, p.lat, p.lng);
      const emMs = Number(p.em);
      let em = new Date();
      if (Number.isFinite(emMs) && emMs > 0) {
        const candidato = new Date(emMs);
        if (candidato.getTime() <= agora + 60000 && candidato.getTime() >= agora - 86400000) {
          em = candidato;
        }
      }
      params.push(em);
    });

    await pool.query(
      `INSERT INTO viagem_pontos (viagem_id, lat, lng, registrado_em) VALUES ${values.join(",")}`,
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
    await pool.query(
      "UPDATE localizacoes_online SET disponivel = FALSE, online_desde = NULL WHERE usuario_id = $1",
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro" });
  }
});

/* ===================== MOTORISTA ONLINE (sem destino) ===================== */
app.get("/api/motorista/online", verificarAuth, async (req, res) => {
  try {
    const hab = await habilitacaoAtiva(req.user.id);
    const row = (await pool.query(
      `SELECT l.disponivel, l.lat, l.lng, l.atualizado_em, l.online_desde, l.vagas,
              (SELECT id FROM caronas WHERE motorista_id = $1 AND status = 'ativa' ORDER BY created_at DESC LIMIT 1) AS carona_id
       FROM localizacoes_online l
       WHERE l.usuario_id = $1 AND l.disponivel = TRUE
         AND NOT (${SQL_GPS_STALE.replace("atualizado_em", "l.atualizado_em")})`,
      [req.user.id]
    )).rows[0];
    const online = !!(hab && row);
    res.json({
      online,
      lat: row?.lat != null ? +row.lat : null,
      lng: row?.lng != null ? +row.lng : null,
      online_desde: row?.online_desde || null,
      atualizado_em: row?.atualizado_em || null,
      vagas: row?.vagas != null ? +row.vagas : 1,
      carona_id: row?.carona_id || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao consultar status online" });
  }
});

app.post("/api/motorista/online", verificarAuth, async (req, res) => {
  const nlat = Number(req.body.lat);
  const nlng = Number(req.body.lng);
  const nvagas = Math.min(6, Math.max(parseInt(req.body.vagas, 10) || 1, 1));
  if (!Number.isFinite(nlat) || !Number.isFinite(nlng) ||
      nlat < -90 || nlat > 90 || nlng < -180 || nlng > 180) {
    return res.status(400).json({ error: "Coordenadas inválidas" });
  }
  try {
    const hab = await habilitacaoAtiva(req.user.id);
    if (!hab) return res.status(403).json({ error: "Ative o modo motorista (foto do carro + selfie) antes de oferecer carona" });
    // Modo online sem destino substitui carona publicada com rota fixa.
    await pool.query(
      "UPDATE caronas SET status = 'cancelada' WHERE motorista_id = $1 AND status = 'ativa'",
      [req.user.id]
    );
    await pool.query(
      `INSERT INTO localizacoes_online (usuario_id, lat, lng, disponivel, online_desde, atualizado_em, vagas)
       VALUES ($1, $2, $3, TRUE, NOW(), NOW(), $4)
       ON CONFLICT (usuario_id)
       DO UPDATE SET lat = $2, lng = $3, disponivel = TRUE, online_desde = NOW(), atualizado_em = NOW(), vagas = $4`,
      [req.user.id, nlat, nlng, nvagas]
    );
    await registrarEventoUso(req.user.id, "motorista_modo_geral", { vagas: nvagas, lat: nlat, lng: nlng });
    res.json({ online: true, lat: nlat, lng: nlng, vagas: nvagas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao ficar online" });
  }
});

app.delete("/api/motorista/online", verificarAuth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE caronas SET status = 'cancelada' WHERE motorista_id = $1 AND status = 'ativa'",
      [req.user.id]
    );
    await pool.query(
      "UPDATE localizacoes_online SET disponivel = FALSE, online_desde = NULL WHERE usuario_id = $1",
      [req.user.id]
    );
    res.json({ online: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao sair do modo online" });
  }
});

// Modo amarelo (online_desde preenchido): nunca expõe carona/destino ao passageiro,
// mesmo se ainda existir registro ativo inconsistente no banco.
function motoristaVisivelPassageiro(row) {
  if (!row?.online_desde) return row;
  return {
    ...row,
    carona_id: null,
    origem_texto: null,
    destino_texto: null,
    origem_lat: null,
    origem_lng: null,
    destino_lat: null,
    destino_lng: null,
    carona_vagas: null,
  };
}

// Motoristas habilitados e online nos últimos 3 min (vistos pelo passageiro).
app.get("/api/motoristas-online", verificarAuth, async (req, res) => {
  const { lat, lng } = req.query;
  try {
    const pid = await projetoDoUsuario(req.user.id);
    if (!pid) return res.json([]);
    const temPos = lat != null && lng != null;
    const params = temPos ? [req.user.id, lat, lng, RAIO_ONLINE_KM, RAIO_VISIVEL_KM, pid] : [req.user.id, pid];
    const distExpr = haversine("lat", "lng", "$2", "$3");
    // Filtro de raio: 600 m modo amarelo (online_desde); 10 km rota publicada (carona).
    // Passageiro sem destino não consulta o mapa; com destino vê os dois tipos.
    const raio = temPos ? `WHERE (
      (online_desde IS NOT NULL AND ${distExpr} <= $4)
      OR (online_desde IS NULL AND carona_id IS NOT NULL AND ${distExpr} <= $5)
    )` : "";
    const filtroProj = temPos ? `AND u.projeto_id = $6` : `AND u.projeto_id = $2`;
    const { rows } = await pool.query(
      `WITH candidatos AS (
         SELECT DISTINCT ON (u.id)
                u.id, u.nome, u.sexo, u.empresa_nome, l.lat, l.lng, l.vagas, l.online_desde,
                h.placa, h.tag, h.foto_carro_url, h.foto_carro_em, h.selfie_url, h.selfie_em,
                ca.id AS carona_id, ca.origem_texto, ca.destino_texto,
                ca.origem_lat, ca.origem_lng, ca.destino_lat, ca.destino_lng, ca.vagas AS carona_vagas
         FROM localizacoes_online l
         JOIN usuarios u ON u.id = l.usuario_id
         JOIN habilitacoes_motorista h
           ON h.motorista_id = u.id AND h.status = 'ativa'
              AND ${sqlSelfieValida("h")}
         LEFT JOIN LATERAL (
           SELECT id, origem_texto, destino_texto, origem_lat, origem_lng, destino_lat, destino_lng, vagas
           FROM caronas
           WHERE motorista_id = u.id AND status = 'ativa'
           ORDER BY created_at DESC
           LIMIT 1
         ) ca ON TRUE
         WHERE l.disponivel = TRUE
           AND COALESCE(u.ativo, TRUE) = TRUE
           AND ${sqlGpsVisivelMapa("l")}
           AND u.id <> $1
           ${filtroProj}
         ORDER BY u.id, h.created_at DESC
       )
       SELECT * FROM candidatos
       ${raio}
       ORDER BY ${temPos ? distExpr : "id"}
       LIMIT 100`,
      params
    );
    res.json(rows.map(motoristaVisivelPassageiro));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar motoristas" });
  }
});

// Prévia (somente leitura) dos motoristas "na pista" da rota escolhida —
// mostra no mapa/lista ANTES mesmo de o passageiro publicar o pedido, do
// mais perto pro mais longe (mesma ordem em que a fila os chamaria).
app.get("/api/motoristas-rota", verificarAuth, async (req, res) => {
  const { origem_lat, origem_lng, destino_lat, destino_lng } = req.query;
  if (origem_lat == null || origem_lng == null || destino_lat == null || destino_lng == null) {
    return res.status(400).json({ error: "Origem e destino são obrigatórios" });
  }
  try {
    const pid = await projetoDoUsuario(req.user.id);
    if (!pid) return res.json([]);
    const distOrigem = haversine("l.lat", "l.lng", "$2", "$3");
    const naPista = sqlMotoristaNaRotaPassageiro("$2", "$3", "$4", "$5", "l.lat", "l.lng", "u.id");
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (u.id)
                u.id, u.nome, u.sexo, l.lat, l.lng, l.online_desde,
                h.placa, h.tag, h.foto_carro_url, h.foto_carro_em, h.selfie_url, h.selfie_em,
                ca.id AS carona_id, ca.origem_texto, ca.destino_texto,
                ca.origem_lat, ca.origem_lng, ca.destino_lat, ca.destino_lng, ca.vagas AS carona_vagas,
                ${distOrigem} AS dist_km
         FROM localizacoes_online l
         JOIN usuarios u ON u.id = l.usuario_id
         JOIN habilitacoes_motorista h
           ON h.motorista_id = u.id AND h.status = 'ativa' AND ${sqlSelfieValida("h")}
         LEFT JOIN LATERAL (
           SELECT id, origem_texto, destino_texto, origem_lat, origem_lng, destino_lat, destino_lng, vagas
           FROM caronas WHERE motorista_id = u.id AND status = 'ativa'
           ORDER BY created_at DESC LIMIT 1
         ) ca ON TRUE
         WHERE l.disponivel = TRUE
           AND COALESCE(u.ativo, TRUE) = TRUE
           AND ${SQL_GPS_FRESH.replace("atualizado_em", "l.atualizado_em")}
           AND u.id <> $1
           AND u.projeto_id = $6
           AND (ca.vagas IS NULL OR ca.vagas > 0)
           AND ${naPista}
         ORDER BY u.id, h.created_at DESC
       ) s
       ORDER BY dist_km ASC
       LIMIT 100`,
      [req.user.id, origem_lat, origem_lng, destino_lat, destino_lng, pid]
    );
    res.json(rows.map((r, i) => ({ ...motoristaVisivelPassageiro(r), ordem: i })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar motoristas na rota" });
  }
});

// Passageiro toca no motorista em modo geral (sem destino): registra uso, avisa o motorista
// e libera o WhatsApp/telefone com mensagem padrão. Vale tanto pro motorista em
// modo geral (combina destino) quanto pro que já publicou carona (buzina/liga
// pra ele direto, sem precisar esperar aceite de proposta) — é o "buzina" da
// fila de motoristas na rota.
app.post("/api/motoristas-online/:id/contato", verificarAuth, async (req, res) => {
  const motoristaId = parseInt(req.params.id, 10);
  if (!motoristaId) return res.status(400).json({ error: "Motorista inválido" });
  const {
    origem_lat, origem_lng, origem_texto,
    destino_lat, destino_lng, destino_texto,
    pessoas,
  } = req.body || {};
  const npessoas = Math.min(6, Math.max(parseInt(pessoas, 10) || 1, 1));
  try {
    if (!(await validarMesmoProjeto(req.user.id, motoristaId, res))) return;

    const hab = await habilitacaoAtiva(motoristaId);
    if (!hab) return res.status(404).json({ error: "Motorista indisponível" });

    const loc = (await pool.query(
      `SELECT l.disponivel, l.lat, l.lng, l.online_desde,
              (SELECT destino_texto FROM caronas WHERE motorista_id = $1 AND status = 'ativa' LIMIT 1) AS destino_texto
       FROM localizacoes_online l WHERE l.usuario_id = $1`,
      [motoristaId]
    )).rows[0];
    const caronaAtiva = (await pool.query(
      `SELECT id, destino_texto, destino_lat, destino_lng, origem_lat, origem_lng, vagas FROM caronas
       WHERE motorista_id = $1 AND status = 'ativa' AND vagas > 0
       ORDER BY created_at DESC LIMIT 1`,
      [motoristaId]
    )).rows[0];
    // Modo amarelo (online_desde): passageiro vê carro dourado sem rota — buzina
    // combina destino, não "Solicitar vaga". Ignora carona residual no banco.
    const modoAmarelo = !!loc?.online_desde;
    const caronaContato = modoAmarelo ? null : caronaAtiva;
    // Lista caronas publicadas ≠ GPS ao vivo: contato vale se online OU carona ativa.
    if (!loc?.disponivel && !caronaContato) {
      return res.status(404).json({ error: "Motorista não está disponível agora" });
    }
    if (caronaContato && caronaContato.vagas < npessoas) {
      return res.status(400).json({
        error: npessoas === 1
          ? "Não há vagas disponíveis nesta carona"
          : `Só há ${caronaContato.vagas} vaga(s) — você pediu ${npessoas}.`,
      });
    }

    const mot = (await pool.query(
      "SELECT nome, telefone FROM usuarios WHERE id = $1",
      [motoristaId]
    )).rows[0];
    if (!mot?.telefone) return res.status(400).json({ error: "Motorista sem WhatsApp cadastrado" });

    const destinoPax = destino_texto ? String(destino_texto).trim() : null;
    const destinoCarona = modoAmarelo ? null : (loc?.destino_texto || caronaContato?.destino_texto);

    let compatContato = "none";
    if (caronaContato?.destino_lat != null && destino_lat != null && destino_lng != null) {
      compatContato = compatRotaPassageiro(
        destino_lat, destino_lng,
        caronaContato.origem_lat, caronaContato.origem_lng,
        caronaContato.destino_lat, caronaContato.destino_lng
      );
      if (compatContato === "total") {
        return res.status(400).json({
          error: "Use Solicitar vaga — vocês vão para o mesmo destino. A buzina não é necessária.",
        });
      }
    }

    const mensagem = destinoPax
      ? `Olá! Quero ir para ${destinoPax}${npessoas > 1 ? ` (${npessoas} pessoas)` : ''}. Posso ir com você?`
      : (destinoCarona
        ? `Olá! Vi que você está indo para ${destinoCarona}. Posso ir com você?`
        : "Olá, qual é o seu destino agora?");

    const prev = (await pool.query(
      `SELECT id FROM contatos_motorista
       WHERE motorista_id = $1 AND passageiro_id = $2 AND lido = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [motoristaId, req.user.id]
    )).rows[0];

    const vals = [
      mensagem,
      origem_lat != null ? +origem_lat : null,
      origem_lng != null ? +origem_lng : null,
      origem_texto || null,
      destino_lat != null ? +destino_lat : null,
      destino_lng != null ? +destino_lng : null,
      destinoPax,
      npessoas,
      compatContato !== "none" ? compatContato : null,
    ];

    let contatoRow;
    if (prev) {
      contatoRow = (await pool.query(
        `UPDATE contatos_motorista SET
           mensagem = $1, origem_lat = $2, origem_lng = $3, origem_texto = $4,
           destino_lat = $5, destino_lng = $6, destino_texto = $7, pessoas = $8,
           compat_rota = $9, created_at = NOW(), lido = FALSE
         WHERE id = $10 RETURNING id`,
        [...vals, prev.id]
      )).rows[0];
      await pool.query(
        `UPDATE contatos_motorista SET lido = TRUE
         WHERE motorista_id = $1 AND passageiro_id = $2 AND lido = FALSE AND id <> $3`,
        [motoristaId, req.user.id, prev.id]
      );
    } else {
      contatoRow = (await pool.query(
        `INSERT INTO contatos_motorista
           (motorista_id, passageiro_id, mensagem,
            origem_lat, origem_lng, origem_texto,
            destino_lat, destino_lng, destino_texto, pessoas, compat_rota)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [motoristaId, req.user.id, ...vals]
      )).rows[0];
    }

    const pax = (await pool.query("SELECT nome, telefone FROM usuarios WHERE id = $1", [req.user.id])).rows[0];
    await registrarEventoUso(req.user.id, "contato_motorista_geral", { motorista_id: motoristaId });
    await registrarEventoUso(motoristaId, "contato_recebido_geral", { passageiro_id: req.user.id });

    const destinoPush = destinoPax || destinoCarona;
    enviarPush(motoristaId, {
      title: destinoPush ? `${pax?.nome || "Passageiro"} quer ir para ${destinoPush}` : "Alguém quer falar com você",
      body: destinoPush
        ? `${npessoas} pessoa(s) — veja no mapa.`
        : `${pax?.nome || "Um passageiro"} quer combinar destino no WhatsApp.`,
      url: "/dashboard.html",
      action: "contato_mapa",
      contato_id: contatoRow.id,
    });

    res.json({ telefone: mot.telefone, mensagem, contato_id: contatoRow.id, atualizado: !!prev });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao solicitar contato" });
  }
});

app.get("/api/motorista/contatos/novos", verificarAuth, async (req, res) => {
  const desde = parseInt(req.query.desde, 10) || 0;
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.mensagem, c.created_at,
              c.origem_lat, c.origem_lng, c.origem_texto,
              c.destino_lat, c.destino_lng, c.destino_texto, c.pessoas,
              u.nome AS passageiro_nome, u.telefone AS passageiro_telefone, u.sexo AS passageiro_sexo
       FROM contatos_motorista c
       JOIN usuarios u ON u.id = c.passageiro_id
       WHERE c.motorista_id = $1 AND c.lido = FALSE AND c.id > $2
       ORDER BY c.id ASC
       LIMIT 20`,
      [req.user.id, desde]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar contatos" });
  }
});

// Contatos recentes com localização — pulso no mapa do motorista (modo amarelo e rota).
app.get("/api/motorista/contatos/mapa", verificarAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (c.passageiro_id)
              c.id, c.passageiro_id, c.mensagem, c.created_at,
              c.origem_lat, c.origem_lng, c.origem_texto,
              c.destino_lat, c.destino_lng, c.destino_texto, c.pessoas, c.compat_rota,
              ca.destino_texto AS destino_motorista_texto,
              ${haversine("ca.destino_lat", "ca.destino_lng", "c.destino_lat", "c.destino_lng")} AS dist_dest_km,
              u.nome AS passageiro_nome, u.telefone AS passageiro_telefone, u.sexo AS passageiro_sexo
       FROM contatos_motorista c
       JOIN usuarios u ON u.id = c.passageiro_id
       LEFT JOIN LATERAL (
         SELECT destino_lat, destino_lng, destino_texto
         FROM caronas
         WHERE motorista_id = c.motorista_id AND status = 'ativa'
         ORDER BY created_at DESC LIMIT 1
       ) ca ON TRUE
       WHERE c.motorista_id = $1
         AND c.lido = FALSE
         AND c.origem_lat IS NOT NULL
         AND c.origem_lng IS NOT NULL
         AND c.created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY c.passageiro_id, c.created_at DESC
       LIMIT 30`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar contatos no mapa" });
  }
});

app.post("/api/motorista/contatos/:id/lido", verificarAuth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE contatos_motorista SET lido = TRUE WHERE id = $1 AND motorista_id = $2",
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro" });
  }
});

app.post("/api/eventos-uso", verificarAuth, async (req, res) => {
  const { evento, detalhes } = req.body;
  if (!evento) return res.status(400).json({ error: "evento obrigatório" });
  try {
    await registrarEventoUso(req.user.id, String(evento).slice(0, 64), detalhes || null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao registrar evento" });
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
      `UPDATE viagens SET fase = 'destino', embarque_em = COALESCE(embarque_em, NOW())
       WHERE id = $1 AND motorista_id = $2 AND status = 'em_andamento'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Viagem não encontrada" });
    await pool.query(
      `DELETE FROM viagem_pontos vp
       WHERE vp.viagem_id = $1
         AND vp.registrado_em < (SELECT embarque_em FROM viagens WHERE id = $1)`,
      [req.params.id]
    );
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

    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const temPos = Number.isFinite(lat) && Number.isFinite(lng);
    let noDestino = false;
    if (temPos && v.destino_lat != null && v.destino_lng != null) {
      noDestino = haversineKmCoord(lat, lng, +v.destino_lat, +v.destino_lng) <= RAIO_CHEGADA_DEST_KM;
    }
    if (req.body?.automatico) {
      if (!noDestino) {
        return res.status(400).json({ error: "Finalização automática só quando o GPS reconhece o destino." });
      }
    }

    const calc = await calcularKmGpsViagem(req.params.id, {
      desde: v.embarque_em || undefined,
    }).catch((err) => {
      console.error("calcularKmGpsViagem falhou (finalizar segue):", err?.message || err);
      return { km: 0, kmBruto: 0, valido: false };
    });
    const med = resolverKmMedicaoViagem(v, calc, req.body?.km_maps, req.body?.km_tela);
    if (!med.valido && noDestino && med.km > 0) {
      med.valido = med.km >= KM_MINIMO_VIAGEM;
    }
    const { rows } = await pool.query(
      `UPDATE viagens SET status = 'concluida', finalizada_em = NOW(),
              distancia_km = $2, deslocamento_valido = $3,
              km_maps = $4, km_tela = $5, km_fonte = $6
       WHERE id = $1 RETURNING *`,
      [req.params.id, med.km, med.valido, med.km_maps, med.km_tela, med.fonte]
    );
    res.json({
      ...rows[0],
      deslocamento_valido: med.valido,
      km_bruto: calc.kmBruto,
      km_fonte: med.fonte,
      chegada_destino: noDestino,
      finalizacao_automatica: !!req.body?.automatico,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao finalizar viagem" });
  }
});

// Motorista ou passageiro podem encerrar viagem presa (em_andamento) quando
// finalizar/cancelar proposta não funciona mais (ex.: fase destino).
app.post("/api/viagens/:id/cancelar", verificarAuth, async (req, res) => {
  try {
    const r = await cancelarViagemAtiva(+req.params.id, req.user.id);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ success: true, viagem: r.viagem });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao encerrar viagem" });
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
              h.placa, h.tag, h.foto_carro_url, h.foto_carro_em,
              h.selfie_url AS motorista_selfie, h.selfie_em AS motorista_selfie_em,
              pr.selfie_url AS passageiro_selfie, pr.selfie_em AS passageiro_selfie_em,
              pd.selfie_url AS pedido_selfie, pd.selfie_em AS pedido_selfie_em
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

function fmtDataBr(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function fmtDataHoraBr(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

async function buscarDadosRateioCompleto(pid, periodo, valorContrato) {
  const [base, totais, ativosQ, porUsuarioQ, viagensQ, concluidasQ] = await Promise.all([
    pool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(pa.empresa_nome), ''), 'Sem empresa') AS empresa_nome,
         COALESCE(NULLIF(TRIM(pa.centro_custo), ''), 'Sem CC') AS centro_custo,
         COUNT(*)::int AS viagens,
         COALESCE(SUM(v.distancia_km), 0) AS km
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemKmValido("v")}
         AND ${sqlViagemNoPeriodo("v")}
       GROUP BY 1, 2`,
      [pid, periodo.de, periodo.ate]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS viagens, COALESCE(SUM(v.distancia_km), 0) AS km
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemKmValido("v")}
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
    pool.query(
      `SELECT
         pa.matricula,
         pa.nome,
         COALESCE(NULLIF(TRIM(pa.empresa_nome), ''), 'Sem empresa') AS empresa_nome,
         COALESCE(NULLIF(TRIM(pa.centro_custo), ''), 'Sem CC') AS centro_custo,
         COUNT(*)::int AS viagens,
         COALESCE(SUM(v.distancia_km), 0) AS km
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemKmValido("v")}
         AND ${sqlViagemNoPeriodo("v")}
       GROUP BY pa.matricula, pa.nome, 3, 4
       ORDER BY viagens DESC, km DESC`,
      [pid, periodo.de, periodo.ate]
    ),
    pool.query(
      `SELECT
         v.id,
         v.iniciada_em,
         v.finalizada_em,
         v.distancia_km,
         m.matricula AS motorista_matricula,
         m.nome AS motorista_nome,
         pa.matricula AS passageiro_matricula,
         pa.nome AS passageiro_nome,
         COALESCE(NULLIF(TRIM(pa.empresa_nome), ''), 'Sem empresa') AS empresa_nome,
         COALESCE(NULLIF(TRIM(pa.centro_custo), ''), 'Sem CC') AS centro_custo
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       JOIN usuarios pa ON v.passageiro_id = pa.id
       WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemKmValido("v")}
         AND ${sqlViagemNoPeriodo("v")}
       ORDER BY v.finalizada_em DESC`,
      [pid, periodo.de, periodo.ate]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS viagens
       FROM viagens v
       JOIN usuarios m ON v.motorista_id = m.id
       WHERE m.projeto_id = $1 AND v.status = 'concluida' AND ${sqlViagemNoPeriodo("v")}`,
      [pid, periodo.de, periodo.ate]
    ),
  ]);

  const totalViagens = numSeguro(totais.rows[0].viagens);
  const totalKm = numSeguro(totais.rows[0].km);
  const usuariosAtivos = numSeguro(ativosQ.rows[0].usuarios_ativos);
  const viagensConcluidasPeriodo = numSeguro(concluidasQ.rows[0].viagens);
  const custoPorViagem = totalViagens ? Math.round((valorContrato / totalViagens) * 100) / 100 : 0;

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

  const porUsuario = porUsuarioQ.rows.map((row) => {
    const share = totalViagens ? row.viagens / totalViagens : 0;
    return {
      matricula: row.matricula,
      nome: row.nome,
      empresa_nome: row.empresa_nome,
      centro_custo: row.centro_custo,
      viagens: row.viagens,
      km: Math.round(Number(row.km) * 100) / 100,
      custo_alocado: Math.round(valorContrato * share * 100) / 100,
      percentual: Math.round(share * 10000) / 100,
    };
  });

  const viagens = viagensQ.rows.map((row) => ({
    id: row.id,
    iniciada_em: row.iniciada_em,
    finalizada_em: row.finalizada_em,
    distancia_km: Math.round(Number(row.distancia_km) * 100) / 100,
    motorista_matricula: row.motorista_matricula,
    motorista_nome: row.motorista_nome,
    passageiro_matricula: row.passageiro_matricula,
    passageiro_nome: row.passageiro_nome,
    empresa_nome: row.empresa_nome,
    centro_custo: row.centro_custo,
    custo_alocado: custoPorViagem,
  }));

  return {
    periodo: {
      de: periodo.de,
      ate: periodo.ate,
      deLabel: periodo.deLabel,
      ateLabel: periodo.ateLabel,
    },
    valor_contrato_mensal: valorContrato,
    totais: {
      viagens: totalViagens,
      viagens_concluidas_periodo: viagensConcluidasPeriodo,
      km: Math.round(totalKm * 100) / 100,
      usuarios_ativos: usuariosAtivos,
      custo_por_km: totalKm > 0 ? Math.round((valorContrato / totalKm) * 100) / 100 : 0,
      custo_por_usuario: usuariosAtivos > 0 ? Math.round((valorContrato / usuariosAtivos) * 100) / 100 : 0,
      custo_por_viagem: custoPorViagem,
    },
    por_empresa: porEmpresa,
    por_centro_custo: porCc.sort((a, b) => b.viagens - a.viagens),
    por_usuario: porUsuario,
    viagens,
  };
}

const XLS_COR = {
  titulo: "FF0D2137",
  tituloTxt: "FFD4A84B",
  cabecalho: "FF1A3A52",
  cabecalhoTxt: "FFFFFFFF",
  zebra: "FFF8F4EC",
  borda: "FFD4C4A8",
  destaque: "FFB8860B",
};

const XLS_FMT = {
  moeda: '"R$" #,##0.00',
  km: '#,##0.00',
  pct: '0.00"%"',
  inteiro: '#,##0',
};

function xlsEstiloTitulo() {
  return {
    font: { name: "Calibri", size: 16, bold: true, color: { argb: XLS_COR.tituloTxt } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: XLS_COR.titulo } },
    alignment: { vertical: "middle", horizontal: "left", wrapText: true },
  };
}

function xlsEstiloSubtitulo() {
  return {
    font: { name: "Calibri", size: 11, color: { argb: "FF334155" } },
    alignment: { vertical: "middle", wrapText: true },
  };
}

function xlsEstiloCabecalho() {
  return {
    font: { name: "Calibri", size: 11, bold: true, color: { argb: XLS_COR.cabecalhoTxt } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: XLS_COR.cabecalho } },
    alignment: { vertical: "middle", horizontal: "center", wrapText: true },
    border: {
      top: { style: "thin", color: { argb: XLS_COR.borda } },
      left: { style: "thin", color: { argb: XLS_COR.borda } },
      bottom: { style: "medium", color: { argb: XLS_COR.destaque } },
      right: { style: "thin", color: { argb: XLS_COR.borda } },
    },
  };
}

function xlsEstiloCelula(alternar = false, alinhamento = "left") {
  const estilo = {
    font: { name: "Calibri", size: 11, color: { argb: "FF1E293B" } },
    alignment: { vertical: "middle", horizontal: alinhamento, wrapText: true },
    border: {
      top: { style: "hair", color: { argb: XLS_COR.borda } },
      left: { style: "hair", color: { argb: XLS_COR.borda } },
      bottom: { style: "hair", color: { argb: XLS_COR.borda } },
      right: { style: "hair", color: { argb: XLS_COR.borda } },
    },
  };
  if (alternar) {
    estilo.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XLS_COR.zebra } };
  }
  return estilo;
}

function xlsEstiloTotal() {
  return {
    font: { name: "Calibri", size: 11, bold: true, color: { argb: XLS_COR.tituloTxt } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: XLS_COR.titulo } },
    alignment: { vertical: "middle", horizontal: "right" },
    border: {
      top: { style: "medium", color: { argb: XLS_COR.destaque } },
      bottom: { style: "medium", color: { argb: XLS_COR.destaque } },
    },
  };
}

function xlsAplicarCabecalho(ws, rowNum, cols) {
  const row = ws.getRow(rowNum);
  row.height = 28;
  cols.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    cell.value = c;
    cell.style = xlsEstiloCabecalho();
  });
}

function xlsAplicarLinha(ws, rowNum, valores, opts = {}) {
  const row = ws.getRow(rowNum);
  row.height = opts.altura || 22;
  valores.forEach((v, i) => {
    const cell = row.getCell(i + 1);
    cell.value = v;
    const alinh = opts.alinhamentos?.[i] || (typeof v === "number" ? "right" : "left");
    cell.style = xlsEstiloCelula(!!opts.zebra, alinh);
    if (opts.formatos?.[i]) cell.numFmt = opts.formatos[i];
  });
}

function xlsConfigurarAba(ws, colunas) {
  colunas.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width;
    if (c.hidden) ws.getColumn(i + 1).hidden = true;
  });
  ws.views = [{ state: "frozen", ySplit: 0, showGridLines: true }];
}

async function gerarWorkbookRateio(dados, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "VAP";
  wb.created = new Date();
  const geradoEm = fmtDataHoraBr(new Date().toISOString());

  // —— Aba Resumo ——
  const wsResumo = wb.addWorksheet("Resumo", {
    properties: { defaultRowHeight: 22 },
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });
  xlsConfigurarAba(wsResumo, [
    { width: 28 }, { width: 22 }, { width: 18 }, { width: 18 },
  ]);
  wsResumo.mergeCells("A1:D1");
  const titulo = wsResumo.getCell("A1");
  titulo.value = "Relatório de Medição e Rateio — VAP";
  titulo.style = xlsEstiloTitulo();
  wsResumo.getRow(1).height = 36;

  const info = [
    ["Projeto", meta.projeto_nome || "—", "Código", meta.projeto_codigo || "—"],
    ["Período (de)", dados.periodo.deLabel || fmtDataBr(dados.periodo.de), "Período (até)", dados.periodo.ateLabel || fmtDataBr(dados.periodo.ate)],
    ["Gerado em", geradoEm, "Contrato mensal (R$)", dados.valor_contrato_mensal],
  ];
  let r = 3;
  info.forEach((linha) => {
    const row = wsResumo.getRow(r++);
    row.height = 24;
    linha.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = v;
      if (i % 2 === 0) {
        cell.style = {
          ...xlsEstiloSubtitulo(),
          font: { ...xlsEstiloSubtitulo().font, bold: true },
        };
      } else if (typeof v === "number") {
        cell.style = xlsEstiloCelula(false, i === 3 ? "right" : "left");
        if (linha[0].includes("Contrato") || (i === 3 && linha[2]?.includes("Contrato"))) cell.numFmt = XLS_FMT.moeda;
      } else {
        cell.style = xlsEstiloCelula(false, "left");
      }
    });
  });

  r += 1;
  wsResumo.mergeCells(`A${r}:D${r}`);
  const sub = wsResumo.getCell(`A${r}`);
  sub.value = "Indicadores do período (somente viagens com deslocamento GPS válido)";
  sub.style = { ...xlsEstiloSubtitulo(), font: { ...xlsEstiloSubtitulo().font, bold: true, size: 12 } };
  wsResumo.getRow(r).height = 26;
  r++;

  const t = dados.totais;
  const indicadores = [
    ["Viagens válidas (GPS)", numSeguro(t.viagens), "Km percorridos", numSeguro(t.km)],
    ["Usuários ativos", numSeguro(t.usuarios_ativos), "Custo por viagem", numSeguro(t.custo_por_viagem)],
    ["Custo por km", numSeguro(t.custo_por_km), "Custo por usuário", numSeguro(t.custo_por_usuario)],
  ];
  indicadores.forEach((linha) => {
    const row = wsResumo.getRow(r++);
    row.height = 24;
    linha.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = numSeguro(v);
      if (i % 2 === 0) {
        cell.style = { ...xlsEstiloSubtitulo(), font: { ...xlsEstiloSubtitulo().font, bold: true } };
      } else if (typeof v === "number" || Number.isFinite(Number(v))) {
        cell.style = xlsEstiloCelula(false, "right");
        cell.numFmt = linha[i - 1].includes("Custo") ? XLS_FMT.moeda
          : linha[i - 1].includes("Km") ? XLS_FMT.km
            : XLS_FMT.inteiro;
      } else {
        cell.style = xlsEstiloCelula(false, "left");
      }
    });
  });

  const conclSemGps = numSeguro(t.viagens_concluidas_periodo) - numSeguro(t.viagens);
  if (numSeguro(t.viagens) === 0 || conclSemGps > 0) {
    r += 1;
    wsResumo.mergeCells(`A${r}:D${r}`);
    const obs = wsResumo.getCell(`A${r}`);
    obs.value = numSeguro(t.viagens) === 0
      ? `Observação: ${numSeguro(t.viagens_concluidas_periodo)} viagem(ns) concluída(s) no período, porém nenhuma com deslocamento GPS válido — só essas entram no rateio e na medição.`
      : `Observação: ${conclSemGps} viagem(ns) concluída(s) no período ficaram de fora por não terem deslocamento GPS válido.`;
    obs.style = { ...xlsEstiloSubtitulo(), font: { ...xlsEstiloSubtitulo().font, italic: true, color: { argb: "FF64748B" } } };
    wsResumo.getRow(r).height = 28;
  }

  r += 1;
  wsResumo.mergeCells(`A${r}:D${r}`);
  wsResumo.getCell(`A${r}`).value = "Onde o valor do contrato está sendo empregado (por empresa)";
  wsResumo.getCell(`A${r}`).style = { ...xlsEstiloSubtitulo(), font: { ...xlsEstiloSubtitulo().font, bold: true, size: 12 } };
  wsResumo.getRow(r).height = 26;
  r++;
  xlsAplicarCabecalho(wsResumo, r++, ["Empresa", "Viagens", "% do contrato", "Custo alocado (R$)"]);
  (dados.por_empresa || []).forEach((e, idx) => {
    xlsAplicarLinha(wsResumo, r++, [e.empresa_nome, e.viagens, e.percentual, e.custo_alocado], {
      zebra: idx % 2 === 0,
      formatos: { 1: XLS_FMT.inteiro, 2: XLS_FMT.pct, 3: XLS_FMT.moeda },
      alinhamentos: ["left", "right", "right", "right"],
    });
  });
  if (dados.por_empresa?.length) {
    const totCusto = dados.por_empresa.reduce((s, e) => s + e.custo_alocado, 0);
    const row = wsResumo.getRow(r++);
    row.height = 26;
    ["Total alocado", t.viagens, 100, totCusto].forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = v;
      cell.style = xlsEstiloTotal();
      if (i === 1) cell.numFmt = XLS_FMT.inteiro;
      if (i === 2) cell.numFmt = XLS_FMT.pct;
      if (i === 3) cell.numFmt = XLS_FMT.moeda;
      if (i === 0) cell.alignment = { vertical: "middle", horizontal: "left" };
    });
  }

  // —— Aba Por Empresa ——
  const wsEmp = wb.addWorksheet("Por Empresa");
  xlsConfigurarAba(wsEmp, [
    { width: 34 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 20 },
  ]);
  let re = 1;
  wsEmp.mergeCells("A1:E1");
  wsEmp.getCell("A1").value = `Rateio por empresa — ${meta.projeto_nome || meta.projeto_codigo}`;
  wsEmp.getCell("A1").style = xlsEstiloTitulo();
  wsEmp.getRow(1).height = 32;
  re = 3;
  xlsAplicarCabecalho(wsEmp, re++, ["Empresa", "Viagens", "Km", "% do contrato", "Custo alocado (R$)"]);
  (dados.por_empresa || []).forEach((e, idx) => {
    xlsAplicarLinha(wsEmp, re++, [e.empresa_nome, e.viagens, e.km, e.percentual, e.custo_alocado], {
      zebra: idx % 2 === 0,
      formatos: { 1: XLS_FMT.inteiro, 2: XLS_FMT.km, 3: XLS_FMT.pct, 4: XLS_FMT.moeda },
      alinhamentos: ["left", "right", "right", "right", "right"],
    });
  });
  wsEmp.views = [{ state: "frozen", ySplit: 3 }];

  // —— Aba Por Centro de Custo ——
  const wsCc = wb.addWorksheet("Por Centro de Custo");
  xlsConfigurarAba(wsCc, [
    { width: 30 }, { width: 26 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 20 },
  ]);
  wsCc.mergeCells("A1:F1");
  wsCc.getCell("A1").value = `Rateio por centro de custo — ${meta.projeto_nome || meta.projeto_codigo}`;
  wsCc.getCell("A1").style = xlsEstiloTitulo();
  wsCc.getRow(1).height = 32;
  let rc = 3;
  xlsAplicarCabecalho(wsCc, rc++, ["Empresa", "Centro de custo", "Viagens", "Km", "% do contrato", "Custo alocado (R$)"]);
  (dados.por_centro_custo || []).forEach((c, idx) => {
    xlsAplicarLinha(wsCc, rc++, [c.empresa_nome, c.centro_custo, c.viagens, c.km, c.percentual, c.custo_alocado], {
      zebra: idx % 2 === 0,
      formatos: { 2: XLS_FMT.inteiro, 3: XLS_FMT.km, 4: XLS_FMT.pct, 5: XLS_FMT.moeda },
      alinhamentos: ["left", "left", "right", "right", "right", "right"],
    });
  });
  wsCc.views = [{ state: "frozen", ySplit: 3 }];

  // —— Aba Por Usuário ——
  const wsUsr = wb.addWorksheet("Por Usuário");
  xlsConfigurarAba(wsUsr, [
    { width: 14 }, { width: 28 }, { width: 28 }, { width: 22 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 20 },
  ]);
  wsUsr.mergeCells("A1:H1");
  wsUsr.getCell("A1").value = `Custo por usuário (passageiro) — ${meta.projeto_nome || meta.projeto_codigo}`;
  wsUsr.getCell("A1").style = xlsEstiloTitulo();
  wsUsr.getRow(1).height = 32;
  let ru = 3;
  xlsAplicarCabecalho(wsUsr, ru++, [
    "Matrícula", "Nome", "Empresa", "Centro de custo", "Viagens", "Km", "% do contrato", "Custo alocado (R$)",
  ]);
  (dados.por_usuario || []).forEach((u, idx) => {
    xlsAplicarLinha(wsUsr, ru++, [
      u.matricula, u.nome, u.empresa_nome, u.centro_custo, u.viagens, u.km, u.percentual, u.custo_alocado,
    ], {
      zebra: idx % 2 === 0,
      formatos: { 4: XLS_FMT.inteiro, 5: XLS_FMT.km, 6: XLS_FMT.pct, 7: XLS_FMT.moeda },
      alinhamentos: ["left", "left", "left", "left", "right", "right", "right", "right"],
    });
  });
  wsUsr.views = [{ state: "frozen", ySplit: 3 }];

  // —— Aba Detalhe Viagens ——
  const wsViag = wb.addWorksheet("Detalhe Viagens");
  xlsConfigurarAba(wsViag, [
    { width: 10 }, { width: 18 }, { width: 18 }, { width: 14 }, { width: 22 },
    { width: 14 }, { width: 22 }, { width: 26 }, { width: 20 }, { width: 12 }, { width: 18 },
  ]);
  wsViag.mergeCells("A1:K1");
  wsViag.getCell("A1").value = `Detalhamento viagem a viagem — ${meta.projeto_nome || meta.projeto_codigo}`;
  wsViag.getCell("A1").style = xlsEstiloTitulo();
  wsViag.getRow(1).height = 32;
  let rv = 3;
  xlsAplicarCabecalho(wsViag, rv++, [
    "ID", "Início", "Fim", "Matr. motorista", "Motorista",
    "Matr. passageiro", "Passageiro", "Empresa", "Centro de custo", "Km GPS", "Custo (R$)",
  ]);
  (dados.viagens || []).forEach((v, idx) => {
    xlsAplicarLinha(wsViag, rv++, [
      v.id,
      fmtDataHoraBr(v.iniciada_em),
      fmtDataHoraBr(v.finalizada_em),
      v.motorista_matricula,
      v.motorista_nome,
      v.passageiro_matricula,
      v.passageiro_nome,
      v.empresa_nome,
      v.centro_custo,
      v.distancia_km,
      v.custo_alocado,
    ], {
      zebra: idx % 2 === 0,
      altura: 24,
      formatos: { 9: XLS_FMT.km, 10: XLS_FMT.moeda },
      alinhamentos: ["center", "center", "center", "left", "left", "left", "left", "left", "left", "right", "right"],
    });
  });
  wsViag.views = [{ state: "frozen", ySplit: 3 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

app.get("/api/admin/rateio", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const periodo = periodoFromQuery(req.query.de, req.query.ate);
  if (!periodo) return res.status(400).json({ error: "Período inválido" });
  const pid = req.adminEscopo.admin_projeto_id;
  const valorContrato = Number(req.adminEscopo.valor_contrato_mensal) || 0;
  try {
    const dados = await buscarDadosRateioCompleto(pid, periodo, valorContrato);
    res.json({
      periodo: dados.periodo,
      valor_contrato_mensal: dados.valor_contrato_mensal,
      totais: dados.totais,
      por_empresa: dados.por_empresa,
      por_centro_custo: dados.por_centro_custo,
      por_usuario: dados.por_usuario,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao calcular rateio" });
  }
});

function slugDataArquivo(val) {
  const s = String(val || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return "data";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

app.get("/api/admin/rateio/export", verificarAuth, carregarAdminEscopo, async (req, res) => {
  const periodo = periodoFromQuery(req.query.de, req.query.ate);
  if (!periodo) return res.status(400).json({ error: "Período inválido" });
  const pid = req.adminEscopo.admin_projeto_id;
  const valorContrato = Number(req.adminEscopo.valor_contrato_mensal) || 0;
  try {
    const dados = await buscarDadosRateioCompleto(pid, periodo, valorContrato);
    const buffer = await gerarWorkbookRateio(dados, {
      projeto_nome: req.adminEscopo.projeto_nome,
      projeto_codigo: req.adminEscopo.projeto_codigo,
    });
    const deSlug = slugDataArquivo(req.query.de || periodo.de);
    const ateSlug = slugDataArquivo(req.query.ate || periodo.ate);
    const cod = (req.adminEscopo.projeto_codigo || "projeto").replace(/[^\w.-]+/g, "_");
    const nomeArq = `Medicao-Rateio-${cod}_${deSlug}_${ateSlug}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${nomeArq}"`);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-store");
    res.end(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao exportar planilha" });
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

/* ==================== FROTA FAKE (testes visuais, admin) ==================== */
require("./sim-frota")({ app, pool, bcrypt, verificarAuth, carregarAdminEscopo });

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
