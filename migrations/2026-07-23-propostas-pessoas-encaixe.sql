-- Propostas: quantidade de pessoas e ponto de encaixe (vaga direta em carona).
ALTER TABLE propostas ADD COLUMN IF NOT EXISTS pessoas INTEGER DEFAULT 1;
ALTER TABLE propostas ADD COLUMN IF NOT EXISTS encaixe_texto TEXT;
ALTER TABLE propostas ADD COLUMN IF NOT EXISTS encaixe_lat NUMERIC(10,6);
ALTER TABLE propostas ADD COLUMN IF NOT EXISTS encaixe_lng NUMERIC(10,6);
ALTER TABLE propostas ADD COLUMN IF NOT EXISTS dest_passageiro_texto TEXT;
ALTER TABLE propostas ADD COLUMN IF NOT EXISTS dest_passageiro_lat NUMERIC(10,6);
ALTER TABLE propostas ADD COLUMN IF NOT EXISTS dest_passageiro_lng NUMERIC(10,6);
