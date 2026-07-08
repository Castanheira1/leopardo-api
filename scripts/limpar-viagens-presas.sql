-- Viagens presas em "em_andamento" (não canceladas nem concluídas)
-- Rode no SQL Editor do Supabase (projeto leopardo) com cuidado.
--
-- 1) Ver o que está preso:
SELECT v.id, v.status, v.fase, v.iniciada_em, v.created_at,
       m.nome AS motorista, pa.nome AS passageiro,
       v.origem_texto, v.destino_texto
FROM viagens v
JOIN usuarios m ON m.id = v.motorista_id
JOIN usuarios pa ON pa.id = v.passageiro_id
WHERE v.status = 'em_andamento'
ORDER BY v.iniciada_em DESC NULLS LAST;

-- 2) Cancelar viagens antigas (mais de 6 horas) — ajuste o intervalo se precisar:
UPDATE viagens
SET status = 'cancelada', finalizada_em = COALESCE(finalizada_em, NOW())
WHERE status = 'em_andamento'
  AND COALESCE(iniciada_em, created_at) < NOW() - INTERVAL '6 hours';

-- 3) Reabrir pedidos que ficaram "atendido" por viagem cancelada:
UPDATE pedidos p
SET status = 'aberto'
FROM viagens v
WHERE v.pedido_id = p.id
  AND v.status = 'cancelada'
  AND p.status = 'atendido'
  AND v.finalizada_em > NOW() - INTERVAL '1 day';

-- 4) Devolver vaga em carona concluída por engano (viagem cancelada recente):
UPDATE caronas c
SET vagas = LEAST(vagas + 1, 6), status = 'ativa'
FROM viagens v
WHERE v.carona_id = c.id
  AND v.status = 'cancelada'
  AND c.status IN ('concluida', 'ativa')
  AND v.finalizada_em > NOW() - INTERVAL '1 day';
