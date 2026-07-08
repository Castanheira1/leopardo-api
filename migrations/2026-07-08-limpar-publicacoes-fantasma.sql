-- Limpa publicações fantasma e garante 1 carona ativa por motorista.
-- Histórico de viagens/rastreio (viagens, viagem_pontos) permanece intacto.

-- 1) Modo amarelo + carona ativa = inconsistente
UPDATE caronas SET status = 'cancelada'
WHERE status = 'ativa'
  AND motorista_id IN (
    SELECT usuario_id FROM localizacoes_online
    WHERE disponivel = TRUE AND online_desde IS NOT NULL
  );

-- 2) Duplicatas: mantém só a mais recente por motorista
UPDATE caronas SET status = 'cancelada'
WHERE status = 'ativa'
  AND id NOT IN (
    SELECT DISTINCT ON (motorista_id) id
    FROM caronas
    WHERE status = 'ativa'
    ORDER BY motorista_id, created_at DESC
  );

-- 3) GPS expirado: desliga online
UPDATE localizacoes_online SET disponivel = FALSE, online_desde = NULL
WHERE disponivel = TRUE
  AND atualizado_em <= NOW() - INTERVAL '3 minutes';

-- 4) Caronas ativas sem motorista online (GPS vivo)
UPDATE caronas c SET status = 'cancelada'
WHERE c.status = 'ativa'
  AND NOT EXISTS (
    SELECT 1 FROM localizacoes_online l
    WHERE l.usuario_id = c.motorista_id
      AND l.disponivel = TRUE
      AND l.atualizado_em > NOW() - INTERVAL '3 minutes'
  );

-- 5) Índice: no máximo 1 publicação ativa por motorista
CREATE UNIQUE INDEX IF NOT EXISTS idx_caronas_um_ativa_por_motorista
ON caronas (motorista_id) WHERE status = 'ativa';
