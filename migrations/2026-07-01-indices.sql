-- ============================================================
-- Índices de performance para o banco VIVO (produção).
-- O schema.sql DROPa as tabelas do fluxo de carona, então NÃO pode ser
-- re-aplicado em produção — rode apenas este arquivo:
--   psql "$DATABASE_URL" -f migrations/2026-07-01-indices.sql
-- Idempotente (IF NOT EXISTS); seguro rodar mais de uma vez.
-- ============================================================

-- Habilitação ativa mais recente do motorista (propostas, motoristas-online, habilitacao/hoje)
CREATE INDEX IF NOT EXISTS idx_habilitacao_ativa ON habilitacoes_motorista (motorista_id, status, created_at DESC);

-- Caronas: match e listagens filtram por status; "minhas caronas" por motorista
CREATE INDEX IF NOT EXISTS idx_caronas_status ON caronas (status);
CREATE INDEX IF NOT EXISTS idx_caronas_motorista ON caronas (motorista_id, status);

-- Pedidos: match, agendador (status + horario) e "meus pedidos"
CREATE INDEX IF NOT EXISTS idx_pedidos_status_horario ON pedidos (status, horario);
CREATE INDEX IF NOT EXISTS idx_pedidos_passageiro ON pedidos (passageiro_id, status);

-- Propostas: a listagem usa (de = $1 OR para = $1) — o planner combina os dois via BitmapOr
CREATE INDEX IF NOT EXISTS idx_propostas_de ON propostas (de_usuario_id);
CREATE INDEX IF NOT EXISTS idx_propostas_para ON propostas (para_usuario_id);
CREATE INDEX IF NOT EXISTS idx_propostas_carona ON propostas (carona_id);
CREATE INDEX IF NOT EXISTS idx_propostas_pedido ON propostas (pedido_id);

-- Viagens: join por proposta, histórico por usuário, overview por status, rateio por data
CREATE INDEX IF NOT EXISTS idx_viagens_proposta ON viagens (proposta_id);
CREATE INDEX IF NOT EXISTS idx_viagens_motorista ON viagens (motorista_id);
CREATE INDEX IF NOT EXISTS idx_viagens_passageiro ON viagens (passageiro_id);
CREATE INDEX IF NOT EXISTS idx_viagens_status ON viagens (status);
CREATE INDEX IF NOT EXISTS idx_viagens_iniciada ON viagens (iniciada_em);
