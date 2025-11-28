-- SCHEMA CORRETO - LEOPARDO 2025 (COMPATÍVEL COM server.js ATUAL)
DROP TABLE IF EXISTS agendamentos CASCADE;
DROP TABLE IF EXISTS viagens CASCADE;

CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    funcao VARCHAR(100),
    matricula VARCHAR(50) UNIQUE NOT NULL,
    senha_hash VARCHAR(255) NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS veiculos (
    id SERIAL PRIMARY KEY,
    modelo VARCHAR(255) NOT NULL,
    placa VARCHAR(20) UNIQUE NOT NULL,
    foto TEXT,
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS viagens (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
    justificativa TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pendente' CHECK (status IN ('pendente', 'em_uso', 'concluido', 'expirado')),
    data_inicio TIMESTAMP,
    data_fim TIMESTAMP,
    tempo_dias INTEGER,
    tempo_horas NUMERIC(10,2),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Admin padrão (000000 / admin123)
INSERT INTO usuarios (nome, funcao, matricula, senha_hash, is_admin)
SELECT 'Administrador', 'Administrador', '000000', 
'$2b$10$QdX5f7eK8Y6i3f2eW9q1Q.Z8j5bN9mK7vL3xP9rT2yU0oP5lM8nHq', TRUE
WHERE NOT EXISTS (SELECT 1 FROM usuarios WHERE matricula = '000000');