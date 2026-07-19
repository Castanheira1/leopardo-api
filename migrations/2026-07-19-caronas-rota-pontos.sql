-- Caminho da carona na malha do projeto (polilinha persistida no post).
ALTER TABLE caronas ADD COLUMN IF NOT EXISTS rota_pontos JSONB;
ALTER TABLE caronas ADD COLUMN IF NOT EXISTS rota_km NUMERIC(8,3);
