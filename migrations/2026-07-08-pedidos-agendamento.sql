-- Agendamento de carona: colunas e índices obrigatórios
-- Rode no Supabase (SQL Editor) se o agendamento não disparar na hora marcada.
-- Idempotente — seguro executar mais de uma vez.

-- 1) Coluna que o agendador usa para saber se já entrou no ar
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pessoas INTEGER DEFAULT 1;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS notificado BOOLEAN DEFAULT FALSE;
UPDATE pedidos SET notificado = FALSE WHERE notificado IS NULL;

-- 2) Índice do agendador (status + horario + notificado)
CREATE INDEX IF NOT EXISTS idx_pedidos_status_horario ON pedidos (status, horario);

-- 3) Fila sequencial na hora do agendamento (mesma do pedido imediato)
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
);
CREATE INDEX IF NOT EXISTS idx_pedido_fila_pedido ON pedido_fila(pedido_id, ordem);
CREATE INDEX IF NOT EXISTS idx_pedido_fila_motorista_ativa ON pedido_fila(motorista_id, status);
