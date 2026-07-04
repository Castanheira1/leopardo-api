-- Favoritos pessoais (cada usuário marca no Perfil do app).
-- Idempotente: pode rodar mais de uma vez no Supabase SQL Editor (projeto leopardo).

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
);

CREATE INDEX IF NOT EXISTS idx_usuarios_favoritos_usuario ON usuarios_favoritos (usuario_id);
