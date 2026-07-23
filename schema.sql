-- ============================================================
-- VAP - Esquema do banco (app de carona interno)
-- Pivot do antigo sistema de reserva de veículos.
--
-- ATENÇÃO: as linhas DROP abaixo apagam dados de carona. Use só em ambiente
-- novo/local. Em produção (leopardo), use scripts/atualizar-banco.sql ou
-- scripts/corrigir-banco-producao.sql (idempotentes, sem DROP).
-- ============================================================

-- Limpa estruturas do fluxo antigo (reserva de veículos)
DROP TABLE IF EXISTS agendamentos CASCADE;
DROP TABLE IF EXISTS viagem_pontos CASCADE;
DROP TABLE IF EXISTS viagens CASCADE;
DROP TABLE IF EXISTS propostas CASCADE;
DROP TABLE IF EXISTS pedido_fila CASCADE;
DROP TABLE IF EXISTS pedidos CASCADE;
DROP TABLE IF EXISTS caronas CASCADE;
DROP TABLE IF EXISTS habilitacoes_motorista CASCADE;
DROP TABLE IF EXISTS veiculos CASCADE;

-- ------------------------------------------------------------
-- Usuários (mantido do sistema antigo + telefone p/ contato)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    funcao VARCHAR(100),
    matricula VARCHAR(50) UNIQUE NOT NULL,
    telefone VARCHAR(20),
    email VARCHAR(255),
    senha_hash VARCHAR(255) NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    sexo VARCHAR(10),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Garante as colunas telefone/email caso a tabela já exista.
-- (As colunas com FK para projetos/empresas são adicionadas mais abaixo,
--  depois que essas tabelas existem — caso contrário um setup limpo falha.)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone VARCHAR(20);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_nome VARCHAR(150);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS centro_custo VARCHAR(100);
-- LGPD: momento e versão da Política de Privacidade aceita no cadastro.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS politica_aceita_em TIMESTAMP;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS politica_versao VARCHAR(20);

-- ------------------------------------------------------------
-- Habilitação de motorista (selfie + foto do carro, válida no dia)
-- Vale 1x por dia; renova ao trocar de carro (placa diferente).
-- ------------------------------------------------------------
CREATE TABLE habilitacoes_motorista (
    id SERIAL PRIMARY KEY,
    motorista_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    data DATE NOT NULL DEFAULT CURRENT_DATE,
    placa VARCHAR(20) NOT NULL,
    tag VARCHAR(50),
    foto_carro_url TEXT,
    foto_carro_lat NUMERIC(10,6),
    foto_carro_lng NUMERIC(10,6),
    foto_carro_em TIMESTAMP,
    selfie_url TEXT,
    selfie_lat NUMERIC(10,6),
    selfie_lng NUMERIC(10,6),
    selfie_em TIMESTAMP,
    status VARCHAR(20) DEFAULT 'ativa' CHECK (status IN ('ativa', 'encerrada')),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_habilitacao_motorista_data ON habilitacoes_motorista (motorista_id, data, placa);
-- Padrão real de acesso das queries: habilitação ativa mais recente do motorista
CREATE INDEX IF NOT EXISTS idx_habilitacao_ativa ON habilitacoes_motorista (motorista_id, status, created_at DESC);

-- ------------------------------------------------------------
-- Caronas (ofertas dos motoristas)
-- ------------------------------------------------------------
CREATE TABLE caronas (
    id SERIAL PRIMARY KEY,
    motorista_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    habilitacao_id INTEGER REFERENCES habilitacoes_motorista(id) ON DELETE SET NULL,
    origem_texto TEXT,
    origem_lat NUMERIC(10,6) NOT NULL,
    origem_lng NUMERIC(10,6) NOT NULL,
    destino_texto TEXT,
    destino_lat NUMERIC(10,6) NOT NULL,
    destino_lng NUMERIC(10,6) NOT NULL,
    horario TIMESTAMP,                 -- NULL = agora (tempo real)
    vagas INTEGER NOT NULL DEFAULT 1,
    observacao TEXT,
    raio_km NUMERIC(4,1) DEFAULT 10,   -- alcance ajustável (barra 1–25 km) da rota
    rota_pontos JSONB,                 -- polilinha da pista (malha): [{nome,lat,lng},...]
    rota_km NUMERIC(8,3),              -- km totais da polilinha (malha ou reta)
    status VARCHAR(20) DEFAULT 'ativa' CHECK (status IN ('ativa', 'concluida', 'cancelada')),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_caronas_status ON caronas (status);
CREATE INDEX IF NOT EXISTS idx_caronas_motorista ON caronas (motorista_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_caronas_um_ativa_por_motorista
ON caronas (motorista_id) WHERE status = 'ativa';

-- ------------------------------------------------------------
-- Pedidos (pedidos de passageiro) - exige selfie ao vivo
-- ------------------------------------------------------------
CREATE TABLE pedidos (
    id SERIAL PRIMARY KEY,
    passageiro_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    origem_texto TEXT,
    origem_lat NUMERIC(10,6) NOT NULL,
    origem_lng NUMERIC(10,6) NOT NULL,
    destino_texto TEXT,
    destino_lat NUMERIC(10,6) NOT NULL,
    destino_lng NUMERIC(10,6) NOT NULL,
    horario TIMESTAMP,                 -- NULL = agora
    pessoas INTEGER DEFAULT 1,         -- quantas pessoas vão na carona
    selfie_url TEXT,
    selfie_lat NUMERIC(10,6),
    selfie_lng NUMERIC(10,6),
    selfie_em TIMESTAMP,
    observacao TEXT,
    notificado BOOLEAN DEFAULT FALSE,  -- pedido agendado só notifica os motoristas na hora marcada
    status VARCHAR(20) DEFAULT 'aberto' CHECK (status IN ('aberto', 'atendido', 'cancelado')),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pedidos_status_horario ON pedidos (status, horario);
CREATE INDEX IF NOT EXISTS idx_pedidos_passageiro ON pedidos (passageiro_id, status);

-- ------------------------------------------------------------
-- Contato direto passageiro -> motorista (o server.js também garante/expande
-- esta tabela no boot, mas propostas.contato_id referencia ela — em banco
-- NOVO ela precisa existir antes do CREATE TABLE propostas abaixo).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contatos_motorista (
    id SERIAL PRIMARY KEY,
    motorista_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    passageiro_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    mensagem TEXT,
    lido BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Propostas (o "match" + aceite, cobre os dois lados)
--   passageiro -> carona : carona_id preenchido + selfie do passageiro
--   motorista  -> pedido : pedido_id preenchido
-- ------------------------------------------------------------
CREATE TABLE propostas (
    id SERIAL PRIMARY KEY,
    de_usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    para_usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    carona_id INTEGER REFERENCES caronas(id) ON DELETE CASCADE,
    pedido_id INTEGER REFERENCES pedidos(id) ON DELETE CASCADE,
    contato_id INTEGER REFERENCES contatos_motorista(id) ON DELETE SET NULL,
    selfie_url TEXT,
    selfie_lat NUMERIC(10,6),
    selfie_lng NUMERIC(10,6),
    selfie_em TIMESTAMP,
    mensagem TEXT,
    pessoas INTEGER DEFAULT 1,
    encaixe_texto TEXT,
    encaixe_lat NUMERIC(10,6),
    encaixe_lng NUMERIC(10,6),
    dest_passageiro_texto TEXT,
    dest_passageiro_lat NUMERIC(10,6),
    dest_passageiro_lng NUMERIC(10,6),
    status VARCHAR(20) DEFAULT 'pendente' CHECK (status IN ('pendente', 'aceito', 'recusado')),
    created_at TIMESTAMP DEFAULT NOW()
);
-- de/para separados: o WHERE usa OR e o planner combina os dois via BitmapOr
CREATE INDEX IF NOT EXISTS idx_propostas_de ON propostas (de_usuario_id);
CREATE INDEX IF NOT EXISTS idx_propostas_para ON propostas (para_usuario_id);
CREATE INDEX IF NOT EXISTS idx_propostas_carona ON propostas (carona_id);
CREATE INDEX IF NOT EXISTS idx_propostas_pedido ON propostas (pedido_id);

-- ------------------------------------------------------------
-- Fila de chamada sequencial de um pedido: motoristas "na rota" (linha reta
-- origem->destino) ordenados do mais perto pro mais longe, ofertados um de
-- cada vez. Quem aceitar primeiro trava; os demais são cancelados.
-- ------------------------------------------------------------
CREATE TABLE pedido_fila (
    id SERIAL PRIMARY KEY,
    pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
    motorista_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    ordem INTEGER NOT NULL,
    dist_km NUMERIC(10,2),
    status VARCHAR(20) NOT NULL DEFAULT 'aguardando'
      CHECK (status IN ('aguardando', 'ofertada', 'aceita', 'recusada', 'expirada', 'cancelada')),
    ofertada_em TIMESTAMP,
    expira_em TIMESTAMP,
    respondida_em TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    -- exclusiva: TRUE = fila "dona" do pedido (só o da vez responde, pulso oculto);
    -- FALSE = fila de notificação do pedido broadcast (pulso continua p/ todos).
    exclusiva BOOLEAN NOT NULL DEFAULT TRUE,
    -- Ponto em comum ("encaixe"): o motorista não vai até o destino do passageiro,
    -- mas a rota dele passa por este ponto — desembarque combinado.
    encaixe_texto TEXT,
    encaixe_lat NUMERIC(10,6),
    encaixe_lng NUMERIC(10,6)
);
CREATE INDEX IF NOT EXISTS idx_pedido_fila_pedido ON pedido_fila (pedido_id, ordem);
CREATE INDEX IF NOT EXISTS idx_pedido_fila_motorista_ativa ON pedido_fila (motorista_id, status);

-- ------------------------------------------------------------
-- Viagens efetivadas (a partir de uma proposta aceita)
-- ------------------------------------------------------------
CREATE TABLE viagens (
    id SERIAL PRIMARY KEY,
    proposta_id INTEGER REFERENCES propostas(id) ON DELETE SET NULL,
    carona_id INTEGER REFERENCES caronas(id) ON DELETE SET NULL,
    pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
    motorista_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    passageiro_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    habilitacao_id INTEGER REFERENCES habilitacoes_motorista(id) ON DELETE SET NULL,
    origem_texto TEXT,
    origem_lat NUMERIC(10,6),
    origem_lng NUMERIC(10,6),
    destino_texto TEXT,
    destino_lat NUMERIC(10,6),
    destino_lng NUMERIC(10,6),
    status VARCHAR(20) DEFAULT 'em_andamento' CHECK (status IN ('em_andamento', 'concluida', 'cancelada')),
    -- fase da viagem: 'encontro' = motorista indo buscar; 'destino' = a caminho do destino
    fase VARCHAR(20) DEFAULT 'encontro' CHECK (fase IN ('encontro', 'destino')),
    distancia_km NUMERIC(10,2),
    deslocamento_valido BOOLEAN DEFAULT FALSE,
    embarque_em TIMESTAMP,
    km_maps NUMERIC(10,2),
    km_tela NUMERIC(10,2),
    km_fonte VARCHAR(20),
    iniciada_em TIMESTAMP DEFAULT NOW(),
    finalizada_em TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_viagens_proposta ON viagens (proposta_id);
CREATE INDEX IF NOT EXISTS idx_viagens_motorista ON viagens (motorista_id);
CREATE INDEX IF NOT EXISTS idx_viagens_passageiro ON viagens (passageiro_id);
CREATE INDEX IF NOT EXISTS idx_viagens_status ON viagens (status);
CREATE INDEX IF NOT EXISTS idx_viagens_iniciada ON viagens (iniciada_em);
-- Parciais (só viagens vivas): ranking/encadeamento e exclusões de mapa
-- consultam "em_andamento por motorista/passageiro" em todo poll.
CREATE INDEX IF NOT EXISTS idx_viagens_motorista_andamento
  ON viagens (motorista_id) WHERE status = 'em_andamento';
CREATE INDEX IF NOT EXISTS idx_viagens_passageiro_andamento
  ON viagens (passageiro_id) WHERE status = 'em_andamento';

-- ------------------------------------------------------------
-- Pontos da rota (rastreamento GPS ao vivo da viagem)
-- ------------------------------------------------------------
CREATE TABLE viagem_pontos (
    id SERIAL PRIMARY KEY,
    viagem_id INTEGER NOT NULL REFERENCES viagens(id) ON DELETE CASCADE,
    lat NUMERIC(10,6) NOT NULL,
    lng NUMERIC(10,6) NOT NULL,
    registrado_em TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_viagem_pontos_viagem ON viagem_pontos (viagem_id, registrado_em);

-- ------------------------------------------------------------
-- Projetos (S11D, Salobo, Carajás, Parauapebas, etc.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projetos (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    codigo VARCHAR(30) UNIQUE NOT NULL,
    valor_contrato_mensal NUMERIC(12,2) DEFAULT 0,
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);
INSERT INTO projetos (nome, codigo) VALUES
    ('S11D', 'S11D'),
    ('Salobo', 'SALOBO'),
    ('Carajás', 'CARAJAS'),
    ('Sossego', 'SOSSEGO')
ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------------------
-- Empresas (Vale, MCA, Serveng, etc.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS empresas (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(150) NOT NULL,
    cnpj VARCHAR(20),
    contato_email VARCHAR(255),
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);
INSERT INTO empresas (nome)
SELECT 'Vale S.A.'
WHERE NOT EXISTS (SELECT 1 FROM empresas WHERE nome = 'Vale S.A.');

-- ------------------------------------------------------------
-- FKs de usuarios -> projetos
-- Empresa no app é texto livre (empresa_nome), não FK para empresas.
-- ------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS projeto_id INTEGER REFERENCES projetos(id) ON DELETE SET NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS admin_projeto_id INTEGER REFERENCES projetos(id) ON DELETE SET NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;
-- 1 sessão ativa por conta (login novo encerra o aparelho anterior)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS sessao_id VARCHAR(64);

-- ------------------------------------------------------------
-- Matrículas bloqueadas (ex-funcionários — impedem novo cadastro)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS matriculas_bloqueadas (
    id SERIAL PRIMARY KEY,
    matricula VARCHAR(50) UNIQUE NOT NULL,
    motivo TEXT,
    bloqueada_em TIMESTAMP DEFAULT NOW(),
    bloqueada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
);

-- ------------------------------------------------------------
-- Contratos (quem paga por quem em cada projeto)
-- pagador_empresa_id = empresa responsável pelo pagamento
-- valor_por_usuario = mensalidade fixa por usuário ativo
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contratos (
    id SERIAL PRIMARY KEY,
    projeto_id INTEGER NOT NULL REFERENCES projetos(id),
    empresa_beneficiaria_id INTEGER NOT NULL REFERENCES empresas(id),
    pagador_empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    valor_por_usuario NUMERIC(10,2) DEFAULT 5.00,
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Chamados de solicitação de acesso admin (validação futura)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_chamados (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    matricula VARCHAR(50) NOT NULL,
    empresa_nome VARCHAR(150),
    projeto_id INTEGER REFERENCES projetos(id),
    telefone VARCHAR(20),
    email VARCHAR(255),
    justificativa TEXT,
    status VARCHAR(20) DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovado', 'recusado')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Tokens de recuperação de senha (link por email, expira em 1h)
CREATE TABLE IF NOT EXISTS tokens_recuperacao (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    expira_em TIMESTAMP NOT NULL,
    usado BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Localização ao vivo (modo "Uber"): posição atual de cada usuário.
-- Motoristas habilitados aparecem no mapa ao vivo; o passageiro acompanha
-- o carro chegando. Uma linha por usuário (sempre sobrescrita).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS localizacoes_online (
    usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
    lat NUMERIC(10,6) NOT NULL,
    lng NUMERIC(10,6) NOT NULL,
    disponivel BOOLEAN DEFAULT TRUE,
    vagas INTEGER DEFAULT 1,
    speed_kmh NUMERIC(5,1),
    online_desde TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loc_online_atualizado ON localizacoes_online (atualizado_em);

-- ------------------------------------------------------------
-- Inscrições de notificação push (Web Push / VAPID). Uma linha por
-- aparelho/navegador; o mesmo usuário pode ter várias. O servidor também
-- cria esta tabela no boot (garantirTabelaPush) caso o schema não seja aplicado.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    criado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_usuario ON push_subscriptions (usuario_id);

-- Tokens FCM/APNs do app Capacitor (push nativo)
CREATE TABLE IF NOT EXISTS push_device_tokens (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    platform VARCHAR(20) NOT NULL DEFAULT 'android',
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_device_usuario ON push_device_tokens (usuario_id);

-- Locais favoritos pessoais (cada usuário marca no Perfil)
CREATE TABLE IF NOT EXISTS usuarios_favoritos (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    busca VARCHAR(300) NOT NULL,
    ref_lat NUMERIC(10,6),
    ref_lng NUMERIC(10,6),
    grupo VARCHAR(100),
    ordem INTEGER NOT NULL DEFAULT 0,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (usuario_id, nome)
);
CREATE INDEX IF NOT EXISTS idx_usuarios_favoritos_usuario ON usuarios_favoritos (usuario_id);

-- Admin padrão (000000 / admin123) — escopo S11D
INSERT INTO usuarios (nome, funcao, matricula, senha_hash, is_admin, admin_projeto_id, ativo)
SELECT 'Administrador', 'Administrador', '000000',
'$2b$10$CU7Cm/xiJrJ10FM9GNmAYu/RrIx67TpjYhJww.gX5kh/JRu5UDpAO', TRUE,
(SELECT id FROM projetos WHERE codigo = 'S11D' LIMIT 1), TRUE
WHERE NOT EXISTS (SELECT 1 FROM usuarios WHERE matricula = '000000');

UPDATE usuarios SET admin_projeto_id = (SELECT id FROM projetos WHERE codigo = 'S11D' LIMIT 1)
WHERE matricula = '000000' AND admin_projeto_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_tokens_recup_hash
    ON tokens_recuperacao(token_hash) WHERE usado = FALSE;

-- ------------------------------------------------------------
-- Segurança Supabase: RLS (app usa pg pool no server.js, não PostgREST/GraphQL)
-- ------------------------------------------------------------
-- Algumas tabelas (anuncios, contatos_motorista, eventos_uso, ...) são criadas
-- em tempo de execução pelo server.js (funções garantir*). Aqui protegemos só as
-- que já existem — o boot do app reforça o RLS nas demais (garantirRlsSupabase).
DO $$
DECLARE
  t TEXT;
  tabelas TEXT[] := ARRAY[
    'matriculas_bloqueadas','push_subscriptions','tokens_recuperacao',
    'usuarios_favoritos','anuncios','contatos_motorista','eventos_uso',
    'pedido_fila','admin_chamados','caronas','pedidos','propostas','viagens',
    'viagem_pontos','habilitacoes_motorista','localizacoes_online','usuarios',
    'contratos','empresas','projetos'
  ];
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      -- anon/authenticated existem no Supabase; em Postgres puro (testes) não.
      BEGIN
        EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;
  END LOOP;
END $$;

ALTER TABLE projetos ADD COLUMN IF NOT EXISTS valor_contrato_mensal NUMERIC(12,2) DEFAULT 0;
