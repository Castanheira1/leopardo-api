-- Atualização idempotente do banco VAP (produção)
-- Seguro para rodar várias vezes. NÃO use schema.sql completo em produção (ele faz DROP).
-- Para correção completa de dados + RLS, use também corrigir-banco-producao.sql

-- Colunas em usuarios
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone VARCHAR(20);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_nome VARCHAR(150);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS centro_custo VARCHAR(100);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS sexo VARCHAR(10);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS projeto_id INTEGER REFERENCES projetos(id);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS admin_projeto_id INTEGER REFERENCES projetos(id);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS politica_aceita_em TIMESTAMP;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS politica_versao VARCHAR(20);

-- Projetos
ALTER TABLE projetos ADD COLUMN IF NOT EXISTS valor_contrato_mensal NUMERIC(12,2) DEFAULT 0;
ALTER TABLE projetos ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;
INSERT INTO projetos (nome, codigo) VALUES
    ('S11D', 'S11D'),
    ('Salobo', 'SALOBO'),
    ('Carajás', 'CARAJAS'),
    ('Sossego', 'SOSSEGO')
ON CONFLICT (codigo) DO NOTHING;

-- Bloqueio de matrícula
CREATE TABLE IF NOT EXISTS matriculas_bloqueadas (
    id SERIAL PRIMARY KEY,
    matricula VARCHAR(50) UNIQUE NOT NULL,
    motivo TEXT,
    bloqueada_em TIMESTAMP DEFAULT NOW(),
    bloqueada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
);

-- Solicitações de acesso admin
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
);

-- Recuperação de senha por link
CREATE TABLE IF NOT EXISTS tokens_recuperacao (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    expira_em TIMESTAMP NOT NULL,
    usado BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tokens_recup_hash
    ON tokens_recuperacao(token_hash) WHERE usado = FALSE;

-- Pedidos / viagens (colunas extras)
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pessoas INTEGER DEFAULT 1;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS notificado BOOLEAN DEFAULT FALSE;
ALTER TABLE viagens ADD COLUMN IF NOT EXISTS fase TEXT DEFAULT 'encontro';
ALTER TABLE localizacoes_online ADD COLUMN IF NOT EXISTS online_desde TIMESTAMP;
ALTER TABLE localizacoes_online ADD COLUMN IF NOT EXISTS vagas INTEGER DEFAULT 1;

CREATE TABLE IF NOT EXISTS eventos_uso (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    evento VARCHAR(64) NOT NULL,
    detalhes JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS contatos_motorista (
    id SERIAL PRIMARY KEY,
    motorista_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    passageiro_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    mensagem TEXT,
    lido BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contatos_motorista_pend ON contatos_motorista (motorista_id, lido, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eventos_uso_usuario ON eventos_uso (usuario_id, created_at DESC);

-- Colunas de localização em contatos (buzina no mapa do motorista)
ALTER TABLE contatos_motorista ADD COLUMN IF NOT EXISTS origem_lat NUMERIC(10,6);
ALTER TABLE contatos_motorista ADD COLUMN IF NOT EXISTS origem_lng NUMERIC(10,6);
ALTER TABLE contatos_motorista ADD COLUMN IF NOT EXISTS origem_texto TEXT;
ALTER TABLE contatos_motorista ADD COLUMN IF NOT EXISTS destino_lat NUMERIC(10,6);
ALTER TABLE contatos_motorista ADD COLUMN IF NOT EXISTS destino_lng NUMERIC(10,6);
ALTER TABLE contatos_motorista ADD COLUMN IF NOT EXISTS destino_texto TEXT;
ALTER TABLE contatos_motorista ADD COLUMN IF NOT EXISTS pessoas INTEGER DEFAULT 1;

-- Admin padrão com escopo S11D
UPDATE usuarios
SET admin_projeto_id = (SELECT id FROM projetos WHERE codigo = 'S11D' LIMIT 1),
    ativo = TRUE
WHERE matricula = '000000' AND admin_projeto_id IS NULL;

-- Segurança Supabase: RLS + revoke anon/authenticated (corrige alertas Security Advisor)
ALTER TABLE matriculas_bloqueadas ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tokens_recuperacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios_favoritos ENABLE ROW LEVEL SECURITY;
ALTER TABLE anuncios ENABLE ROW LEVEL SECURITY;
ALTER TABLE contatos_motorista ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventos_uso ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedido_fila ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_chamados ENABLE ROW LEVEL SECURITY;
ALTER TABLE caronas ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE propostas ENABLE ROW LEVEL SECURITY;
ALTER TABLE viagens ENABLE ROW LEVEL SECURITY;
ALTER TABLE viagem_pontos ENABLE ROW LEVEL SECURITY;
ALTER TABLE habilitacoes_motorista ENABLE ROW LEVEL SECURITY;
ALTER TABLE localizacoes_online ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE contratos ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE projetos ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  REVOKE ALL ON matriculas_bloqueadas FROM anon, authenticated;
  REVOKE ALL ON push_subscriptions FROM anon, authenticated;
  REVOKE ALL ON tokens_recuperacao FROM anon, authenticated;
  REVOKE ALL ON usuarios_favoritos FROM anon, authenticated;
  REVOKE ALL ON anuncios FROM anon, authenticated;
  REVOKE ALL ON contatos_motorista FROM anon, authenticated;
  REVOKE ALL ON eventos_uso FROM anon, authenticated;
  REVOKE ALL ON pedido_fila FROM anon, authenticated;
  REVOKE ALL ON admin_chamados FROM anon, authenticated;
  REVOKE ALL ON caronas FROM anon, authenticated;
  REVOKE ALL ON pedidos FROM anon, authenticated;
  REVOKE ALL ON propostas FROM anon, authenticated;
  REVOKE ALL ON viagens FROM anon, authenticated;
  REVOKE ALL ON viagem_pontos FROM anon, authenticated;
  REVOKE ALL ON habilitacoes_motorista FROM anon, authenticated;
  REVOKE ALL ON localizacoes_online FROM anon, authenticated;
  REVOKE ALL ON usuarios FROM anon, authenticated;
  REVOKE ALL ON contratos FROM anon, authenticated;
  REVOKE ALL ON empresas FROM anon, authenticated;
  REVOKE ALL ON projetos FROM anon, authenticated;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
