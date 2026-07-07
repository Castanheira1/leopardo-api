-- Segurança Supabase: RLS + revoke anon/authenticated
-- O app VAP acessa o Postgres via DATABASE_URL (pool Node), não PostgREST.
-- Isso corrige avisos "RLS disabled" e exposição GraphQL/Data API.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'matriculas_bloqueadas',
    'push_subscriptions',
    'tokens_recuperacao',
    'usuarios_favoritos',
    'anuncios',
    'contatos_motorista',
    'eventos_uso',
    'pedido_fila',
    'admin_chamados',
    'caronas',
    'pedidos',
    'propostas',
    'viagens',
    'viagem_pontos',
    'habilitacoes_motorista',
    'localizacoes_online',
    'usuarios',
    'contratos',
    'empresas',
    'projetos'
  ] LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
    EXCEPTION
      WHEN undefined_table THEN
        RAISE NOTICE 'Tabela % não existe — ignorada', t;
      WHEN OTHERS THEN
        RAISE NOTICE 'RLS em %: %', t, SQLERRM;
    END;
  END LOOP;
END $$;
