-- Recupera um usuário desativado/bloqueado (substitua a matrícula).
-- Seguro para rodar no SQL Editor do Supabase.

UPDATE usuarios
SET ativo = TRUE
WHERE matricula = '234567';

DELETE FROM matriculas_bloqueadas
WHERE matricula = '234567';
