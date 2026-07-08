-- Caronas antigas / fantasma (ex.: Vale · Civic QRM7E33 · Portaria S11D)
-- Rode no SQL Editor do Supabase (projeto leopardo).

-- 1) Ver rotas ativas suspeitas:
SELECT c.id, c.status, c.destino_texto, c.origem_texto, c.vagas, c.created_at,
       u.nome, u.empresa_nome, h.placa, h.tag,
       l.disponivel, l.atualizado_em, l.online_desde
FROM caronas c
JOIN usuarios u ON u.id = c.motorista_id
LEFT JOIN habilitacoes_motorista h ON h.motorista_id = u.id AND h.status = 'ativa'
LEFT JOIN localizacoes_online l ON l.usuario_id = c.motorista_id
WHERE c.status = 'ativa'
ORDER BY c.created_at DESC;

-- 2) Cancelar TODAS as caronas ativas sem motorista online (GPS vivo):
UPDATE caronas c SET status = 'cancelada'
WHERE c.status = 'ativa'
  AND NOT EXISTS (
    SELECT 1 FROM localizacoes_online l
    WHERE l.usuario_id = c.motorista_id
      AND l.disponivel = TRUE
      AND l.atualizado_em > NOW() - INTERVAL '3 minutes'
  );

-- 3) (Opcional) Cancelar só o registro antigo da Vale / Portaria S11D:
-- UPDATE caronas c SET status = 'cancelada'
-- FROM usuarios u
-- LEFT JOIN habilitacoes_motorista h ON h.motorista_id = u.id AND h.status = 'ativa'
-- WHERE c.motorista_id = u.id
--   AND c.status = 'ativa'
--   AND (
--     h.placa ILIKE '%QRM7E33%'
--     OR c.destino_texto ILIKE '%Portaria S11D%'
--     OR u.empresa_nome ILIKE '%Vale%'
--   );

-- 4) Conferir que sumiu:
SELECT COUNT(*) AS ainda_ativas FROM caronas WHERE status = 'ativa';
