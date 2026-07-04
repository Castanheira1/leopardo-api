-- Correção idempotente do banco leopardo (produção)
-- Seguro para rodar várias vezes. NÃO use schema.sql completo em produção (ele faz DROP).

-- Colunas LGPD / comerciais
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS politica_aceita_em TIMESTAMP;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS politica_versao VARCHAR(20);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone VARCHAR(20);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_nome VARCHAR(150);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS centro_custo VARCHAR(100);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS sexo VARCHAR(10);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS projeto_id INTEGER REFERENCES projetos(id);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS admin_projeto_id INTEGER REFERENCES projetos(id);

ALTER TABLE projetos ADD COLUMN IF NOT EXISTS valor_contrato_mensal NUMERIC(12,2) DEFAULT 0;
ALTER TABLE projetos ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;

INSERT INTO projetos (nome, codigo) VALUES
    ('S11D', 'S11D'),
    ('Salobo', 'SALOBO'),
    ('Carajás', 'CARAJAS'),
    ('Sossego', 'SOSSEGO')
ON CONFLICT (codigo) DO NOTHING;

-- Nomes alinhados ao cadastro
UPDATE projetos SET nome = 'S11D' WHERE codigo = 'S11D' AND nome <> 'S11D';
UPDATE projetos SET nome = 'Salobo' WHERE codigo = 'SALOBO' AND nome <> 'Salobo';
UPDATE projetos SET nome = 'Carajás' WHERE codigo = 'CARAJAS' AND nome <> 'Carajás';
UPDATE projetos SET nome = 'Sossego' WHERE codigo = 'SOSSEGO' AND nome <> 'Sossego';

-- Ativar todos os usuários
UPDATE usuarios SET ativo = TRUE WHERE ativo IS DISTINCT FROM TRUE;

-- Legado: consentimento para quem cadastrou antes da LGPD no app
UPDATE usuarios
SET politica_aceita_em = COALESCE(politica_aceita_em, created_at, NOW()),
    politica_versao = COALESCE(politica_versao, '1.0')
WHERE politica_aceita_em IS NULL;

-- Completar cadastro de usuários legados incompletos
UPDATE usuarios
SET empresa_nome = COALESCE(NULLIF(TRIM(empresa_nome), ''), 'Vale'),
    projeto_id = COALESCE(projeto_id, (SELECT id FROM projetos WHERE codigo = 'S11D' LIMIT 1))
WHERE matricula = '123456';

UPDATE usuarios
SET admin_projeto_id = (SELECT id FROM projetos WHERE codigo = 'S11D' LIMIT 1),
    ativo = TRUE
WHERE matricula = '000000' AND admin_projeto_id IS NULL;

-- Remover chamados de teste
DELETE FROM admin_chamados WHERE matricula IN ('999999998', '999998');

-- Empresa duplicada (mantém id=1)
DELETE FROM empresas e
WHERE e.id <> (SELECT MIN(id) FROM empresas WHERE nome = e.nome)
  AND NOT EXISTS (SELECT 1 FROM contratos c WHERE c.empresa_beneficiaria_id = e.id OR c.pagador_empresa_id = e.id);

-- Tabelas auxiliares
CREATE TABLE IF NOT EXISTS matriculas_bloqueadas (
    id SERIAL PRIMARY KEY,
    matricula VARCHAR(50) UNIQUE NOT NULL,
    motivo TEXT,
    bloqueada_em TIMESTAMP DEFAULT NOW(),
    bloqueada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
);

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

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pessoas INTEGER DEFAULT 1;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS notificado BOOLEAN DEFAULT FALSE;
ALTER TABLE viagens ADD COLUMN IF NOT EXISTS fase TEXT DEFAULT 'encontro';

-- Segurança Supabase: RLS nas tabelas que estavam expostas sem proteção
ALTER TABLE matriculas_bloqueadas ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tokens_recuperacao ENABLE ROW LEVEL SECURITY;

-- O app acessa via pooler (server.js); bloqueia anon/authenticated na API pública
DO $$ BEGIN
  REVOKE ALL ON matriculas_bloqueadas FROM anon, authenticated;
  REVOKE ALL ON push_subscriptions FROM anon, authenticated;
  REVOKE ALL ON tokens_recuperacao FROM anon, authenticated;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
