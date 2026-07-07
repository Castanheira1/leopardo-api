-- Cancela caronas ativas duplicadas: mantém só a mais recente por motorista.
-- Sintoma: mesmo motorista aparece 2x em "Motoristas indo para lá" (vagas diferentes).
UPDATE caronas SET status = 'cancelada'
WHERE status = 'ativa'
  AND id NOT IN (
    SELECT DISTINCT ON (motorista_id) id
    FROM caronas
    WHERE status = 'ativa'
    ORDER BY motorista_id, created_at DESC
  );
