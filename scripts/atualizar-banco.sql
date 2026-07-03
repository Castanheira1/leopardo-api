-- Atualização idempotente do banco VAP (projeto leopardo)
-- Seguro para rodar várias vezes. NÃO use schema.sql completo em produção (ele faz DROP).

-- Colunas em usuarios
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone VARCHAR(20);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_nome VARCHAR(150);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS centro_custo VARCHAR(100);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS sexo VARCHAR(10);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS projeto_id INTEGER REFERENCES projetos(id);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS admin_projeto_id INTEGER REFERENCES projetos(id);

-- Projetos
ALTER TABLE projetos ADD COLUMN IF NOT EXISTS valor_contrato_mensal NUMERIC(12,2) DEFAULT 0;
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

-- Admin padrão com escopo S11D
UPDATE usuarios
SET admin_projeto_id = (SELECT id FROM projetos WHERE codigo = 'S11D' LIMIT 1),
    ativo = TRUE
WHERE matricula = '000000' AND admin_projeto_id IS NULL;
