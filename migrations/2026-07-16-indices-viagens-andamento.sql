-- Índices parciais para as checagens quentes de "viagem em andamento":
-- - ranking/encadeamento conta viagens ativas por motorista a cada pedido;
-- - mapa de pedidos e limpeza excluem passageiros já em viagem a cada poll.
-- Parciais em status='em_andamento' ficam minúsculos (só as viagens vivas).
-- Idempotente: pode rodar mais de uma vez.
CREATE INDEX IF NOT EXISTS idx_viagens_motorista_andamento
  ON viagens (motorista_id) WHERE status = 'em_andamento';
CREATE INDEX IF NOT EXISTS idx_viagens_passageiro_andamento
  ON viagens (passageiro_id) WHERE status = 'em_andamento';
