-- Segurança Supabase Storage + tabelas de simulação
-- Rode no Supabase (SQL Editor). Idempotente — seguro executar mais de uma vez.
--
-- Contexto: o bucket "veiculos" (selfies + fotos de carro) tinha 3 policies
-- "permitir_tudo" liberando INSERT/UPDATE/DELETE ao role `public` (ou seja, à
-- chave anon/publishable, que é discoverável). Qualquer um poderia sobrescrever
-- ou APAGAR as fotos de todos os motoristas. O servidor faz upload com a chave
-- `service_role` (bypassa RLS), então remover essas policies NÃO quebra o upload.

-- 1) Remove as policies públicas de escrita/exclusão no storage.
DROP POLICY IF EXISTS "permitir_tudo xp9rus_1" ON storage.objects;  -- INSERT public
DROP POLICY IF EXISTS "permitir_tudo xp9rus_2" ON storage.objects;  -- UPDATE public
DROP POLICY IF EXISTS "permitir_tudo xp9rus_3" ON storage.objects;  -- DELETE public

-- 2) Tabelas de simulação: a migração de RLS anterior não as cobria e elas ainda
--    tinham grant para anon/authenticated (leitura via PostgREST). Revoga.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sim_frota','sim_rotas'] LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
    EXCEPTION
      WHEN undefined_table THEN RAISE NOTICE 'Tabela % não existe — ignorada', t;
      WHEN OTHERS THEN RAISE NOTICE 'Hardening %: %', t, SQLERRM;
    END;
  END LOOP;
END $$;

-- PENDENTE (fora desta migração, exige mudança de código coordenada):
-- Tornar o bucket "veiculos" PRIVADO e servir as fotos por Signed URLs de curta
-- duração (o servidor já usa service_role e pode gerar as URLs assinadas). Hoje o
-- bucket é público: quem tiver a URL exata de uma foto consegue abri-la (a
-- listagem/enumeração já está bloqueada — não há policy de SELECT para o anon).
