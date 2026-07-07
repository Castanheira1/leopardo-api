-- Diagnóstico: modo amarelo vs carona publicada (VAP)
-- Rode no SQL Editor do Supabase do projeto VAP (DATABASE_URL do Render):
--   psql "$DATABASE_URL" -f scripts/diagnostico-modo-amarelo.sql

\echo '=== 1) INCONSISTÊNCIA: modo amarelo + carona ativa (BUG) ==='
SELECT u.id, u.nome, u.empresa_nome,
       l.online_desde, l.atualizado_em,
       c.id AS carona_id, c.destino_texto, c.destino_lat, c.destino_lng
FROM localizacoes_online l
JOIN usuarios u ON u.id = l.usuario_id
JOIN caronas c ON c.motorista_id = u.id AND c.status = 'ativa'
WHERE l.disponivel = TRUE AND l.online_desde IS NOT NULL
ORDER BY l.atualizado_em DESC;

\echo '=== 2) Motoristas online agora (modo amarelo vs carona) ==='
SELECT u.id, u.nome,
       l.online_desde IS NOT NULL AS modo_amarelo,
       l.online_desde, l.atualizado_em,
       c.id AS carona_id, c.destino_texto
FROM localizacoes_online l
JOIN usuarios u ON u.id = l.usuario_id
LEFT JOIN LATERAL (
  SELECT id, destino_texto FROM caronas
  WHERE motorista_id = u.id AND status = 'ativa'
  ORDER BY created_at DESC LIMIT 1
) c ON TRUE
WHERE l.disponivel = TRUE
ORDER BY l.atualizado_em DESC
LIMIT 30;

\echo '=== 3) Vários caronas ativas por motorista (anormal) ==='
SELECT motorista_id, COUNT(*) AS qtd
FROM caronas WHERE status = 'ativa'
GROUP BY motorista_id HAVING COUNT(*) > 1;

\echo '=== 4) Caronas ativas sem motorista online ==='
SELECT c.id, c.motorista_id, u.nome, c.destino_texto, c.created_at
FROM caronas c
JOIN usuarios u ON u.id = c.motorista_id
LEFT JOIN localizacoes_online l ON l.usuario_id = c.motorista_id AND l.disponivel = TRUE
WHERE c.status = 'ativa' AND l.usuario_id IS NULL
ORDER BY c.created_at DESC
LIMIT 20;

\echo '=== CORREÇÃO MANUAL (se houver linhas no item 1) ==='
-- UPDATE caronas SET status = 'cancelada'
-- WHERE status = 'ativa'
--   AND motorista_id IN (
--     SELECT usuario_id FROM localizacoes_online
--     WHERE disponivel = TRUE AND online_desde IS NOT NULL
--   );
