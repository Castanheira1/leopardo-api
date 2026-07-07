-- Medição de km só após embarque + fontes auxiliares (Maps / tela) para relatórios.
ALTER TABLE viagens ADD COLUMN IF NOT EXISTS embarque_em TIMESTAMP;
ALTER TABLE viagens ADD COLUMN IF NOT EXISTS km_maps NUMERIC(10,2);
ALTER TABLE viagens ADD COLUMN IF NOT EXISTS km_tela NUMERIC(10,2);
ALTER TABLE viagens ADD COLUMN IF NOT EXISTS km_fonte VARCHAR(20);
