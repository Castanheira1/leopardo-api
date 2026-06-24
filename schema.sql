-- ============================================================
-- VAGÃO - Esquema do banco (app de carona interno)
-- Pivot do antigo sistema de reserva de veículos.
-- ============================================================

-- Limpa estruturas do fluxo antigo (reserva de veículos)
DROP TABLE IF EXISTS agendamentos CASCADE;
DROP TABLE IF EXISTS viagem_pontos CASCADE;
DROP TABLE IF EXISTS viagens CASCADE;
DROP TABLE IF EXISTS propostas CASCADE;
DROP TABLE IF EXISTS pedidos CASCADE;
DROP TABLE IF EXISTS caronas CASCADE;
DROP TABLE IF EXISTS habilitacoes_motorista CASCADE;
DROP TABLE IF EXISTS veiculos CASCADE;

-- ------------------------------------------------------------
-- Usuários (mantido do sistema antigo + telefone p/ contato)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    funcao VARCHAR(100),
    matricula VARCHAR(50) UNIQUE NOT NULL,
    telefone VARCHAR(20),
    email VARCHAR(255),
    senha_hash VARCHAR(255) NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    sexo VARCHAR(10),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Garante as colunas telefone/email caso a tabela já exista.
-- (As colunas com FK para projetos/empresas são adicionadas mais abaixo,
--  depois que essas tabelas existem — caso contrário um setup limpo falha.)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone VARCHAR(20);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_nome VARCHAR(150);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS centro_custo VARCHAR(100);

-- ------------------------------------------------------------
-- Habilitação de motorista (selfie + foto do carro, válida no dia)
-- Vale 1x por dia; renova ao trocar de carro (placa diferente).
-- ------------------------------------------------------------
CREATE TABLE habilitacoes_motorista (
    id SERIAL PRIMARY KEY,
    motorista_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    data DATE NOT NULL DEFAULT CURRENT_DATE,
    placa VARCHAR(20) NOT NULL,
    tag VARCHAR(50),
    foto_carro_url TEXT,
    foto_carro_lat NUMERIC(10,6),
    foto_carro_lng NUMERIC(10,6),
    foto_carro_em TIMESTAMP,
    selfie_url TEXT,
    selfie_lat NUMERIC(10,6),
    selfie_lng NUMERIC(10,6),
    selfie_em TIMESTAMP,
    status VARCHAR(20) DEFAULT 'ativa' CHECK (status IN ('ativa', 'encerrada')),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_habilitacao_motorista_data ON habilitacoes_motorista (motorista_id, data, placa);

-- ------------------------------------------------------------
-- Caronas (ofertas dos motoristas)
-- ------------------------------------------------------------
CREATE TABLE caronas (
    id SERIAL PRIMARY KEY,
    motorista_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    habilitacao_id INTEGER REFERENCES habilitacoes_motorista(id) ON DELETE SET NULL,
    origem_texto TEXT,
    origem_lat NUMERIC(10,6) NOT NULL,
    origem_lng NUMERIC(10,6) NOT NULL,
    destino_texto TEXT,
    destino_lat NUMERIC(10,6) NOT NULL,
    destino_lng NUMERIC(10,6) NOT NULL,
    horario TIMESTAMP,                 -- NULL = agora (tempo real)
    vagas INTEGER NOT NULL DEFAULT 1,
    observacao TEXT,
    status VARCHAR(20) DEFAULT 'ativa' CHECK (status IN ('ativa', 'concluida', 'cancelada')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Pedidos (pedidos de passageiro) - exige selfie ao vivo
-- ------------------------------------------------------------
CREATE TABLE pedidos (
    id SERIAL PRIMARY KEY,
    passageiro_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    origem_texto TEXT,
    origem_lat NUMERIC(10,6) NOT NULL,
    origem_lng NUMERIC(10,6) NOT NULL,
    destino_texto TEXT,
    destino_lat NUMERIC(10,6) NOT NULL,
    destino_lng NUMERIC(10,6) NOT NULL,
    horario TIMESTAMP,                 -- NULL = agora
    pessoas INTEGER DEFAULT 1,         -- quantas pessoas vão na carona
    selfie_url TEXT,
    selfie_lat NUMERIC(10,6),
    selfie_lng NUMERIC(10,6),
    selfie_em TIMESTAMP,
    observacao TEXT,
    status VARCHAR(20) DEFAULT 'aberto' CHECK (status IN ('aberto', 'atendido', 'cancelado')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Propostas (o "match" + aceite, cobre os dois lados)
--   passageiro -> carona : carona_id preenchido + selfie do passageiro
--   motorista  -> pedido : pedido_id preenchido
-- ------------------------------------------------------------
CREATE TABLE propostas (
    id SERIAL PRIMARY KEY,
    de_usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    para_usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    carona_id INTEGER REFERENCES caronas(id) ON DELETE CASCADE,
    pedido_id INTEGER REFERENCES pedidos(id) ON DELETE CASCADE,
    selfie_url TEXT,
    selfie_lat NUMERIC(10,6),
    selfie_lng NUMERIC(10,6),
    selfie_em TIMESTAMP,
    mensagem TEXT,
    status VARCHAR(20) DEFAULT 'pendente' CHECK (status IN ('pendente', 'aceito', 'recusado')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Viagens efetivadas (a partir de uma proposta aceita)
-- ------------------------------------------------------------
CREATE TABLE viagens (
    id SERIAL PRIMARY KEY,
    proposta_id INTEGER REFERENCES propostas(id) ON DELETE SET NULL,
    carona_id INTEGER REFERENCES caronas(id) ON DELETE SET NULL,
    pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
    motorista_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    passageiro_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    habilitacao_id INTEGER REFERENCES habilitacoes_motorista(id) ON DELETE SET NULL,
    origem_texto TEXT,
    origem_lat NUMERIC(10,6),
    origem_lng NUMERIC(10,6),
    destino_texto TEXT,
    destino_lat NUMERIC(10,6),
    destino_lng NUMERIC(10,6),
    status VARCHAR(20) DEFAULT 'em_andamento' CHECK (status IN ('em_andamento', 'concluida', 'cancelada')),
    -- fase da viagem: 'encontro' = motorista indo buscar; 'destino' = a caminho do destino
    fase VARCHAR(20) DEFAULT 'encontro' CHECK (fase IN ('encontro', 'destino')),
    iniciada_em TIMESTAMP DEFAULT NOW(),
    finalizada_em TIMESTAMP,
    distancia_km NUMERIC(10,2),
    created_at TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Pontos da rota (rastreamento GPS ao vivo da viagem)
-- ------------------------------------------------------------
CREATE TABLE viagem_pontos (
    id SERIAL PRIMARY KEY,
    viagem_id INTEGER NOT NULL REFERENCES viagens(id) ON DELETE CASCADE,
    lat NUMERIC(10,6) NOT NULL,
    lng NUMERIC(10,6) NOT NULL,
    registrado_em TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_viagem_pontos_viagem ON viagem_pontos (viagem_id, registrado_em);

-- ------------------------------------------------------------
-- Projetos (S11D, Salobo, Carajás, Parauapebas, etc.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projetos (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    codigo VARCHAR(30) UNIQUE NOT NULL,
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);
INSERT INTO projetos (nome, codigo) VALUES
    ('S11D Eliezer Batista', 'S11D'),
    ('Salobo', 'SALOBO'),
    ('Carajás', 'CARAJAS'),
    ('Parauapebas', 'PARAUAPEBAS')
ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------------------
-- Empresas (Vale, MCA, Serveng, etc.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS empresas (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(150) NOT NULL,
    cnpj VARCHAR(20),
    contato_email VARCHAR(255),
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);
INSERT INTO empresas (nome) VALUES ('Vale S.A.')
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- FKs de usuarios -> projetos/empresas
-- (adicionadas aqui, após as tabelas referenciadas existirem)
-- ------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS projeto_id INTEGER REFERENCES projetos(id) ON DELETE SET NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS admin_projeto_id INTEGER REFERENCES projetos(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- Contratos (quem paga por quem em cada projeto)
-- pagador_empresa_id = empresa responsável pelo pagamento
-- valor_por_usuario = mensalidade fixa por usuário ativo
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contratos (
    id SERIAL PRIMARY KEY,
    projeto_id INTEGER NOT NULL REFERENCES projetos(id),
    empresa_beneficiaria_id INTEGER NOT NULL REFERENCES empresas(id),
    pagador_empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    valor_por_usuario NUMERIC(10,2) DEFAULT 5.00,
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Chamados de solicitação de acesso admin (validação futura)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_chamados (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    matricula VARCHAR(50) NOT NULL,
    empresa_nome VARCHAR(150),
    projeto_id INTEGER REFERENCES projetos(id),
    telefone VARCHAR(20),
    email VARCHAR(255),
    justificativa TEXT,
    status VARCHAR(20) DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovado', 'recusado')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Localização ao vivo (modo "Uber"): posição atual de cada usuário.
-- Motoristas habilitados aparecem no mapa ao vivo; o passageiro acompanha
-- o carro chegando. Uma linha por usuário (sempre sobrescrita).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS localizacoes_online (
    usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
    lat NUMERIC(10,6) NOT NULL,
    lng NUMERIC(10,6) NOT NULL,
    disponivel BOOLEAN DEFAULT TRUE,
    atualizado_em TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loc_online_atualizado ON localizacoes_online (atualizado_em);

-- ------------------------------------------------------------
-- Inscrições de notificação push (Web Push / VAPID). Uma linha por
-- aparelho/navegador; o mesmo usuário pode ter várias. O servidor também
-- cria esta tabela no boot (garantirTabelaPush) caso o schema não seja aplicado.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    criado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_usuario ON push_subscriptions (usuario_id);

-- Admin padrão (000000 / admin123)
INSERT INTO usuarios (nome, funcao, matricula, senha_hash, is_admin)
SELECT 'Administrador', 'Administrador', '000000',
'$2b$10$CU7Cm/xiJrJ10FM9GNmAYu/RrIx67TpjYhJww.gX5kh/JRu5UDpAO', TRUE
WHERE NOT EXISTS (SELECT 1 FROM usuarios WHERE matricula = '000000');
