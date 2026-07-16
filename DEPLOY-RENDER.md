# Deploy do VAP no Render

Guia passo a passo para colocar o app no ar. O banco (schema) **já foi aplicado**
no Supabase `vsxnqtecnvhhvekmkshb`; falta hospedar a aplicação e ligar as
variáveis de ambiente.

> **HTTPS é obrigatório.** Câmera (selfie/foto do carro) e GPS só funcionam
> em `https://` (ou `localhost`). O Render entrega HTTPS automático, então está OK.

---

## 1. Criar o bucket de fotos no Supabase Storage

1. Supabase → **Storage** → **New bucket**
2. Nome: **`veiculos`**
3. Marque como **Public bucket**
   *(o app gera URLs públicas com `getPublicUrl` para exibir as fotos no histórico).*
4. Create bucket.

O upload é feito **pelo servidor** usando a chave `service_role` (passo 3), que
ignora as policies de Storage — então não precisa criar policy de INSERT.

---

## 2. Pegar a connection string do banco (atenção ao pooler!)

No Supabase → botão **Connect** (topo) → aba **Connection string**.

> **Importante:** use a string do **Session pooler** (IPv4), **não** a
> "Direct connection". O Render free roda em IPv4 e o host direto
> (`db.vsxnqtecnvhhvekmkshb.supabase.co`) só responde em IPv6 — a conexão direta
> falha com timeout.

A string do pooler tem este formato (usuário com o ref do projeto + host `pooler`):

```
postgresql://postgres.vsxnqtecnvhhvekmkshb:[SUA-SENHA]@aws-0-<regiao>.pooler.supabase.com:5432/postgres
```

Guarde-a para o passo 4 (`DATABASE_URL`). Se esqueceu a senha do banco:
Supabase → **Project Settings → Database → Reset database password**.

---

## 3. Pegar as chaves de API

| Variável | Onde achar |
|---|---|
| `SUPABASE_URL` | Settings → API → **Project URL** (`https://vsxnqtecnvhhvekmkshb.supabase.co`) |
| `SUPABASE_KEY` | Settings → API → **`service_role`** (secreta — fica só no servidor, nunca no front) |
| `GOOGLE_MAPS_API_KEY` | Google Cloud Console → APIs habilitadas: **Maps JavaScript API**, **Places API (New)** e **Routes API**. Restrinja por domínio depois do deploy. |

---

## 4. Deploy no Render

1. Render → **New +** → **Blueprint**.
2. Conecte o repositório deste projeto no GitHub.
3. O Render lê o `render.yaml` e cria o serviço **vagao**.
4. Em **Environment**, preencha os segredos (`sync: false`):

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | string do **Session pooler** (passo 2) |
   | `SUPABASE_URL` | `https://vsxnqtecnvhhvekmkshb.supabase.co` |
   | `SUPABASE_KEY` | chave `service_role` |
   | `GOOGLE_MAPS_API_KEY` | chave do Google Maps |
   | `RESEND_API_KEY` | [resend.com](https://resend.com) → API Keys. **Sem ela a recuperação de senha responde 503 em produção.** |

   Sobre o email de recuperação: o remetente padrão (`EMAIL_FROM`) é
   `VAP <onboarding@resend.dev>`, que o Resend só entrega para o email da
   própria conta Resend — bom para testar. Para os usuários receberem de
   verdade, verifique um domínio no Resend e troque `EMAIL_FROM` para ele.

   Já vêm prontas do blueprint: `NODE_VERSION=22`, `NODE_ENV=production`,
   `JWT_SECRET` (gerado automático), `SUPABASE_BUCKET=veiculos`, `RAIO_MATCH_KM=3`.

   > **Node 22 é obrigatório.** O `@supabase/supabase-js` quebra no boot em Node < 22
   > (`Node.js NN detected without native WebSocket support`, erro no `createClient`).
   > O repositório já fixa isso via `.node-version` (`22`) e `engines`. **Se você criou o
   > serviço manualmente** (sem o blueprint) e ele subir em Node 18/20, adicione a
   > variável **`NODE_VERSION=22`** no painel (Environment) e faça um novo deploy.
5. **Create** → aguarde o build (`npm install` compila o `bcrypt`, leva ~1-2 min).

---

## 5. Pós-deploy (validação)

1. Abra a URL do Render (`https://vagao.onrender.com` ou similar).
2. Nos logs do Render, confirme: **`Conectado ao PostgreSQL`** e **`Servidor rodando`**.
   - Se aparecer `Erro ao conectar` → revise a `DATABASE_URL` (provavelmente está
     usando a conexão direta IPv6 em vez do pooler).
3. Defina **ADMIN_SENHA** no Environment do Render e faça login com o admin semente: **matrícula `000000` / a senha da env**. (Sem a env, se a senha padrão `admin123` ainda estiver ativa, a conta é desativada no boot por segurança.)
4. **Troque a senha do admin** imediatamente (painel admin → reset de senha).
5. Teste o fluxo: registrar usuário → pedir carona (selfie ao vivo) → oferecer
   carona → match → aceitar → viagem com GPS.

---

## 6. Notas de segurança (follow-up)

- **Senha do admin semente**: definida via `ADMIN_SENHA` (o boot substitui a padrão automaticamente).
- **Google Maps key:** restringir por referrer/domínio no Google Cloud para não
  ser usada por terceiros (a chave é exposta no front via `/api/config`).
- **RLS no Supabase:** o app acessa o Postgres direto como `postgres` (via
  `DATABASE_URL`), então não depende de RLS. Mas se a `anon key` do projeto
  estiver em uso em algum lugar, considere habilitar RLS nas tabelas para que a
  API PostgREST pública não exponha os dados.
- **CORS:** hoje está `origin: "*"`. Para um app interno, vale restringir ao
  domínio final depois que a URL estiver definida.
