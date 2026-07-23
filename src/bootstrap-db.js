// Boot do banco: auto-heal de colunas/tabelas, RLS e limpezas de publicação fantasma.
require("dotenv").config();
const bcrypt = require("bcrypt");
const { GPS_STALE_MIN, SQL_GPS_STALE } = require("./config");
const { pool } = require("./db");
const { garantirTabelaErros } = require("./erros");

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
      garantirColunasContatosMotorista, garantirTabelaErros, garantirRlsSupabase,
      garantirAdminSemSenhaPadrao, garantirUsuarioDonoEmpresa,
    ];
    for (const passo of passos) {
      try { await passo(); } catch (e) { console.warn(`${passo.name}:`, e.message); }
    }
  })
  .catch((err) => console.log("Erro ao conectar:", err.message));

// Admin semente (matrícula 000000): a senha padrão admin123 do schema.sql é
// pública no repositório e NÃO pode valer em produção.
// - ADMIN_SENHA definida no ambiente: se o admin ainda usa admin123, troca pela
//   senha da env no boot (idempotente; não sobrescreve senha já trocada à mão).
// - Produção SEM ADMIN_SENHA: se o admin ainda usa admin123, a conta é
//   DESATIVADA (login bloqueado) até definirem ADMIN_SENHA ou trocarem a senha.
// - Dev/teste sem a env: comportamento de sempre (000000/admin123 funciona).
async function garantirAdminSemSenhaPadrao() {
  // schema usa senha_hash (não "senha") — tenta ambos por compatibilidade.
  const { rows } = await pool.query(
    `SELECT id, COALESCE(senha_hash, '') AS senha_hash, COALESCE(ativo, TRUE) AS ativo
     FROM usuarios WHERE matricula = '000000'`
  );
  const admin = rows[0];
  if (!admin) return;
  const usaPadrao = await bcrypt.compare("admin123", admin.senha_hash || "").catch(() => false);
  const senhaEnv = process.env.ADMIN_SENHA || "";
  if (senhaEnv) {
    if (usaPadrao) {
      const hash = await bcrypt.hash(senhaEnv, 10);
      await pool.query("UPDATE usuarios SET senha_hash = $1, ativo = TRUE WHERE id = $2", [hash, admin.id]);
      console.log("Admin 000000: senha padrão substituída pela ADMIN_SENHA do ambiente.");
    }
    return;
  }
  if (process.env.NODE_ENV === "production" && usaPadrao && admin.ativo) {
    await pool.query("UPDATE usuarios SET ativo = FALSE WHERE id = $1", [admin.id]);
    console.error(
      "SEGURANÇA: admin 000000 ainda usava a senha padrão admin123 em produção — conta DESATIVADA. " +
      "Defina ADMIN_SENHA no ambiente (o boot reativa com a nova senha)."
    );
  }
}

// Conta dedicada ao DONO DA EMPRESA (visão multi-projeto / dashboard executivo).
// Matrícula padrão 900000 — distinta do admin de canteiro (000000).
// Senha: DONO_SENHA, senão ADMIN_SENHA, senão 654321 (6 dígitos, padrão do app).
async function garantirUsuarioDonoEmpresa() {
  const matricula = String(process.env.DONO_MATRICULA || "900000").trim();
  if (!matricula) return;
  const SENHA_PADRAO_DONO = "654321";
  try {
    const { rows } = await pool.query(
      "SELECT id, senha_hash, COALESCE(ativo, TRUE) AS ativo FROM usuarios WHERE matricula = $1",
      [matricula]
    );
    const senhaDesejada = process.env.DONO_SENHA || process.env.ADMIN_SENHA || SENHA_PADRAO_DONO;

    if (!rows.length) {
      const hash = await bcrypt.hash(senhaDesejada, 10);
      await pool.query(
        `INSERT INTO usuarios (
           nome, funcao, matricula, senha_hash, is_admin, admin_projeto_id, projeto_id,
           ativo, empresa_nome, telefone, email, politica_aceita_em, politica_versao
         ) VALUES (
           'Dono da empresa', 'Dono', $1, $2, TRUE, NULL, NULL, TRUE,
           'VAP', '00000000000', $3, NOW(), '1.0'
         )`,
        [matricula, hash, `dono@${matricula}.vap.local`]
      );
      console.log(
        `Dono da empresa: conta criada (matrícula ${matricula}). ` +
        (process.env.DONO_SENHA || process.env.ADMIN_SENHA
          ? "Senha definida por DONO_SENHA/ADMIN_SENHA."
          : `Senha inicial ${SENHA_PADRAO_DONO} — defina DONO_SENHA em produção.`)
      );
      return;
    }

    // Dono global: is_admin, mas SEM amarrar a um único canteiro (admin_projeto_id null)
    // — o dashboard é multi-projeto em dono.html. Pode abrir admin.html se quiser
    // um canteiro específico depois de vincular manualmente.
    await pool.query(
      `UPDATE usuarios SET
         is_admin = TRUE,
         ativo = TRUE,
         funcao = COALESCE(NULLIF(funcao, ''), 'Dono'),
         nome = CASE WHEN nome IS NULL OR nome = '' OR nome = 'Dono da empresa' THEN 'Dono da empresa' ELSE nome END,
         admin_projeto_id = NULL
       WHERE id = $1`,
      [rows[0].id]
    );

    const usaPadrao = await bcrypt.compare(SENHA_PADRAO_DONO, rows[0].senha_hash || "").catch(() => false);
    if (process.env.DONO_SENHA && usaPadrao) {
      const hash = await bcrypt.hash(process.env.DONO_SENHA, 10);
      await pool.query("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [hash, rows[0].id]);
      console.log(`Dono ${matricula}: senha padrão trocada por DONO_SENHA.`);
    } else if (process.env.NODE_ENV === "production" && usaPadrao && !process.env.DONO_SENHA && !process.env.ADMIN_SENHA) {
      console.warn(
        `SEGURANÇA: dono ${matricula} ainda usa senha padrão ${SENHA_PADRAO_DONO}. Defina DONO_SENHA no Render.`
      );
    }
  } catch (e) {
    console.warn("garantirUsuarioDonoEmpresa:", e.message);
  }
}

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
    // Uma sessão ativa por conta (bloqueia login simultâneo em 2 aparelhos).
    "sessao_id VARCHAR(64)",
  ];
  for (const c of colunas) {
    try {
      await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ${c}`);
    } catch (e) {
      console.warn("garantirColunasUsuarios:", e.message);
    }
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
    // Selfie do passageiro (referência visual para o motorista no modal "Quer carona").
    "selfie_url TEXT",
  ];
  for (const col of colunas) {
    try {
      await pool.query(`ALTER TABLE contatos_motorista ADD COLUMN IF NOT EXISTS ${col}`);
    } catch (e) {
      console.warn("garantirColunasContatosMotorista:", e.message);
    }
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
    "eventos_erro",
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
    // Carona parcial (motorista só vai até um ponto no caminho, ex.: Portaria): o
    // destino_* segue sendo o destino FINAL do passageiro; a parada do motorista
    // (onde ele desembarca e pega outra carona) fica em destino_motorista_*. A tela
    // de viagem já desenha preto até a parada + dourado da parada ao destino.
    await pool.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS destino_motorista_texto TEXT");
    await pool.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS destino_motorista_lat NUMERIC(10,6)");
    await pool.query("ALTER TABLE viagens ADD COLUMN IF NOT EXISTS destino_motorista_lng NUMERIC(10,6)");
    // Oferta a um contato ("quer carona"/buzina): guarda de qual contato veio, pra
    // a viagem herdar embarque/destino do passageiro e desenhar a rota.
    await pool.query("ALTER TABLE propostas ADD COLUMN IF NOT EXISTS contato_id INTEGER");
    await pool.query("ALTER TABLE propostas ADD COLUMN IF NOT EXISTS pessoas INTEGER DEFAULT 1");
    await pool.query("ALTER TABLE propostas ADD COLUMN IF NOT EXISTS encaixe_texto TEXT");
    await pool.query("ALTER TABLE propostas ADD COLUMN IF NOT EXISTS encaixe_lat NUMERIC(10,6)");
    await pool.query("ALTER TABLE propostas ADD COLUMN IF NOT EXISTS encaixe_lng NUMERIC(10,6)");
    await pool.query("ALTER TABLE propostas ADD COLUMN IF NOT EXISTS dest_passageiro_texto TEXT");
    await pool.query("ALTER TABLE propostas ADD COLUMN IF NOT EXISTS dest_passageiro_lat NUMERIC(10,6)");
    await pool.query("ALTER TABLE propostas ADD COLUMN IF NOT EXISTS dest_passageiro_lng NUMERIC(10,6)");
    // Alcance (km) ajustável da carona com destino: raio em que passageiros veem a
    // rota e o motorista recebe/enxerga os pedidos. Barra 1–25 km no app (default 10).
    await pool.query("ALTER TABLE caronas ADD COLUMN IF NOT EXISTS raio_km NUMERIC(4,1) DEFAULT 10");
    // Sequência de pontos da pista (malha do projeto) calculada no POST da carona.
    await pool.query("ALTER TABLE caronas ADD COLUMN IF NOT EXISTS rota_pontos JSONB");
    await pool.query("ALTER TABLE caronas ADD COLUMN IF NOT EXISTS rota_km NUMERIC(8,3)");
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
    // Tokens FCM/APNs do app Capacitor (push nativo).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_device_tokens (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        platform VARCHAR(20) NOT NULL DEFAULT 'android',
        criado_em TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_push_device_usuario ON push_device_tokens(usuario_id)");
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
    // exclusiva: fila "dona" do pedido (modo usar_fila antigo — pulso some e só o
    // da vez responde). FALSE = fila de NOTIFICAÇÃO do pedido broadcast: chama o
    // melhor motorista um a um, mas o pulso continua no mapa de todos e qualquer
    // um pode oferecer. encaixe_*: ponto em comum calculado no ranking (o
    // motorista não vai até o destino do passageiro, mas passa por este ponto).
    await pool.query("ALTER TABLE pedido_fila ADD COLUMN IF NOT EXISTS exclusiva BOOLEAN NOT NULL DEFAULT TRUE");
    await pool.query("ALTER TABLE pedido_fila ADD COLUMN IF NOT EXISTS encaixe_texto TEXT");
    await pool.query("ALTER TABLE pedido_fila ADD COLUMN IF NOT EXISTS encaixe_lat NUMERIC(10,6)");
    await pool.query("ALTER TABLE pedido_fila ADD COLUMN IF NOT EXISTS encaixe_lng NUMERIC(10,6)");
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


module.exports = {
  garantirColunasUsuarios,
  garantirSchemaComercial,
  garantirTabelaAnuncios,
  garantirTabelaEventosUso,
  garantirColunasContatosMotorista,
  garantirRlsSupabase,
  garantirColunasPedidos,
  garantirColunasLocalizacao,
  corrigirInconsistenciasModoAmarelo,
  garantirCaronasUnicasAtivas,
  garantirIndiceCaronaUnica,
  limparLocalizacoesFantasma,
  limparCaronasOrfas,
  limparPublicacoesFantasma,
  garantirColunasViagens,
  garantirTabelaPush,
  garantirTabelaPedidoFila,
  garantirTabelaFavoritos,
};
