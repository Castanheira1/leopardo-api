-- ============================================================
-- LEOPARDO CARONA - Esquema do banco (app de carona interno)
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
    created_at TIMESTAMP DEFAULT NOW()
);

-- Garante as colunas telefone/email caso a tabela já exista
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone VARCHAR(20);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email VARCHAR(255);

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

-- Admin padrão (000000 / admin123)
INSERT INTO usuarios (nome, funcao, matricula, senha_hash, is_admin)
SELECT 'Administrador', 'Administrador', '000000',
'$2b$10$CU7Cm/xiJrJ10FM9GNmAYu/RrIx67TpjYhJww.gX5kh/JRu5UDpAO', TRUE
WHERE NOT EXISTS (SELECT 1 FROM usuarios WHERE matricula = '000000');
