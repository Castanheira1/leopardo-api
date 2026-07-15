-- Fila de notificação não-exclusiva + ponto em comum ("encaixe").
-- Idempotente: pode rodar mais de uma vez sem efeito colateral.
--
-- exclusiva: TRUE = fila "dona" do pedido (modo usar_fila: pulso oculto, só o
--            motorista da vez responde). FALSE = fila de NOTIFICAÇÃO do pedido
--            broadcast: o melhor motorista é chamado um a um, mas o pulso
--            continua no mapa de todos e qualquer um pode oferecer.
-- encaixe_*: ponto em comum calculado no ranking — o motorista não vai até o
--            destino do passageiro, mas a rota dele passa por este ponto
--            (ex.: todo mundo passa pela Portaria).
ALTER TABLE pedido_fila ADD COLUMN IF NOT EXISTS exclusiva BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE pedido_fila ADD COLUMN IF NOT EXISTS encaixe_texto TEXT;
ALTER TABLE pedido_fila ADD COLUMN IF NOT EXISTS encaixe_lat NUMERIC(10,6);
ALTER TABLE pedido_fila ADD COLUMN IF NOT EXISTS encaixe_lng NUMERIC(10,6);
