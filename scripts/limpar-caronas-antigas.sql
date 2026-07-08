-- Limpa publicações fantasma (ex.: Vale · Civic QRM7E33 · Portaria S11D)
-- Rode no SQL Editor do banco de produção (Supabase/Render).
-- Histórico de viagens e rastreio (viagens, viagem_pontos) NÃO é apagado.

-- 1) Diagnóstico: rotas ativas suspeitas
SELECT c.id, c.status, c.destino_texto, c.origem_texto, c.vagas, c.created_at,
       u.nome, u.empresa_nome, h.placa, h.tag,
       l.disponivel, l.atualizado_em, l.online_desde
FROM caronas c
JOIN usuarios u ON u.id = c.motorista_id
LEFT JOIN habilitacoes_motorista h ON h.motorista_id = u.id AND h.status = 'ativa'
LEFT JOIN localizacoes_online l ON l.usuario_id = c.motorista_id
WHERE c.status = 'ativa'
ORDER BY c.created_at DESC;

-- 2) Modo amarelo + carona ativa (inconsistente)
UPDATE caronas SET status = 'cancelada'
WHERE status = 'ativa'
  AND motorista_id IN (
    SELECT usuario_id FROM localizacoes_online
    WHERE disponivel = TRUE AND online_desde IS NOT NULL
  );

-- 3) Duplicatas: mantém só a publicação mais recente por motorista
UPDATE caronas SET status = 'cancelada'
WHERE status = 'ativa'
  AND id NOT IN (
    SELECT DISTINCT ON (motorista_id) id
    FROM caronas
    WHERE status = 'ativa'
    ORDER BY motorista_id, created_at DESC
  );

-- 4) Desliga motoristas com GPS expirado (> 3 min)
UPDATE localizacoes_online SET disponivel = FALSE, online_desde = NULL
WHERE disponivel = TRUE
  AND atualizado_em <= NOW() - INTERVAL '3 minutes';

-- 5) Cancela caronas ativas sem motorista online (GPS vivo)
UPDATE caronas c SET status = 'cancelada'
WHERE c.status = 'ativa'
  AND NOT EXISTS (
    SELECT 1 FROM localizacoes_online l
    WHERE l.usuario_id = c.motorista_id
      AND l.disponivel = TRUE
      AND l.atualizado_em > NOW() - INTERVAL '3 minutes'
  );

-- 6) Índice: impede novas duplicatas
CREATE UNIQUE INDEX IF NOT EXISTS idx_caronas_um_ativa_por_motorista
ON caronas (motorista_id) WHERE status = 'ativa';

-- 7) Conferir resultado
SELECT COUNT(*) AS ainda_ativas FROM caronas WHERE status = 'ativa';
SELECT COUNT(*) AS online_vivo FROM localizacoes_online
WHERE disponivel = TRUE AND atualizado_em > NOW() - INTERVAL '3 minutes';
