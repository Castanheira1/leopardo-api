# 📋 Handoff — Pivot Leopardo → Vagão (app de carona interno)

> Documento de continuidade. Gerado em **2026-06-17**.
> Repositório: `Castanheira1/leopardo-api`
> Branch de trabalho: `claude/leopardo-ride-sharing-me5pc6`

---

## 1. Status atual (o ponto em que paramos)

- ✅ Todo o desenvolvimento está **commitado na branch local** `claude/leopardo-ride-sharing-me5pc6`.
- ✅ Committer já corrigido para ficar "verified" (`noreply@anthropic.com` / `Claude`).
- ⛔ **NÃO foi possível enviar (push) nem abrir o PR** — o token desta sessão está **somente-leitura**.
- 🌐 A branch existe no remoto até o commit `27a748b`; faltam **2 commits** novos (abaixo).

### Por que travou
O token do GitHub é gerado no **início da sessão**. A liberação de escrita foi feita depois, então o token atual continuou com escopo de leitura. Todos os caminhos de escrita retornaram `403`:

| Ação | Resultado |
|---|---|
| `git push` | `403 Permission denied` |
| API `push_files` / `create_or_update_file` | `403 Resource not accessible by integration` |
| API `create_pull_request` | `403 Resource not accessible by integration` |

### Como destravar
1. **Abrir uma sessão nova** do Claude Code neste repo (gera token novo já com escrita). — *recomendado*
2. Conferir no **GitHub App "Claude"** (repo `leopardo-api` → Settings → GitHub Apps): **Contents: Read and write** + **Pull requests: Read and write**.

---

## 2. Commits pendentes de push

```
668f463  Aplica marca Vagão na tela de login
77b98c3  Pivota Leopardo para Vagão (app de carona interno)
```
(em cima de `27a748b`, que já está no remoto)

---

## 3. O que é o Vagão (visão geral)

Pivot do antigo **Leopardo** (sistema de reserva de veículos) para o **Vagão**: app interno
de **carona** estilo "mini Uber" entre colaboradores. O mesmo usuário alterna entre
**motorista** e **passageiro**. Reaproveita base de usuários, autenticação (JWT+bcrypt) e
armazenamento de fotos (Supabase Storage).

### Funcionalidades
- Modo motorista/passageiro no mesmo app.
- **Pedir carona:** GPS como origem, destino no mapa, **selfie ao vivo**, publica pedido.
- **Oferecer carona:** ativa modo motorista com **selfie + foto do carro** (placa via **OCR**
  editável + **TAG** manual). Habilitação vale o dia; renova ao trocar de carro.
- **Match por proximidade** (Haversine) de origem **e** destino + horário compatível.
- **Aceite + contato:** ao aceitar, libera o **WhatsApp/telefone** do outro.
- **Viagem com rastreamento GPS ao vivo** (grava a rota).
- **Histórico de segurança:** rota + fotos (selfies/carro) com data e local.

### Segurança das fotos
Capturadas **ao vivo** (`getUserMedia`, sem anexar arquivo), com carimbo de horário e
localização. Vão para o **Supabase Storage**; tabelas guardam URL + metadados. Câmera/GPS
exigem HTTPS (ou localhost).

### Tecnologias
- **Backend:** Node.js + Express, PostgreSQL (Supabase), JWT + bcrypt, Helmet, Multer.
- **Frontend:** HTML/CSS/JS puro, Google Maps (mapa + Places Autocomplete), Tesseract.js (OCR).
- **Storage:** Supabase Storage.

---

## 4. Arquivos alterados/criados (13)

| Arquivo | Status | O que tem |
|---|---|---|
| `server.js` | M (832 linhas) | Backend completo do fluxo de carona |
| `schema.sql` | M | Novo esquema do banco |
| `package.json` | M | nome `leopardo-carona` v2.0.0 + deps |
| `README.md` | M | Documentação do Vagão |
| `.env.example` | A | Variáveis de ambiente |
| `.gitignore` | A | node_modules, .env, *.log, .DS_Store |
| `public/index.html` | M | Login com marca Vagão |
| `public/registro.html` | M | Cadastro com telefone |
| `public/dashboard.html` | M | App (mapa, modos, câmera, propostas, viagem) |
| `public/historico.html` | A | Histórico com rota + fotos |
| `public/admin.html` | M | Painel admin |
| `public/app.js` | M | Auth, Maps, câmera/OCR, utilidades |
| `public/style.css` | M | Estilos (marca Vale/Vagão) |

---

## 5. Modelo de dados (`schema.sql`)

Tabelas (com `DROP ... CASCADE` do fluxo antigo de reserva):
- `usuarios` — mantida; **+ coluna `telefone`** (contato pós-aceite).
- `habilitacoes_motorista` — selfie + foto do carro + placa + tag; válida no dia; status ativa/encerrada.
- `caronas` — ofertas do motorista (origem/destino lat-lng, horário NULL=agora, vagas).
- `pedidos` — pedidos do passageiro (exige selfie ao vivo).
- `propostas` — o "match" + aceite, cobre os 2 lados (carona_id OU pedido_id).
- `viagens` — viagem efetivada a partir de proposta aceita (status, distância_km).
- `viagem_pontos` — pontos GPS da rota (rastreamento ao vivo).
- Admin padrão: **matrícula 000000 / senha admin123**.

---

## 6. Endpoints (`server.js`)

| Área | Endpoint |
|---|---|
| Auth | `POST /api/register`, `POST /api/login`, `GET/PATCH /api/perfil` |
| Config | `GET /api/config` (devolve Google Maps key) |
| Fotos | `POST /api/fotos` (multipart, captura ao vivo → Supabase) |
| Motorista | `GET /api/habilitacao/hoje`, `POST /api/habilitacao` |
| Caronas | `POST/GET /api/caronas`, `DELETE /api/caronas/:id`, `GET /api/caronas/match` |
| Pedidos | `POST/GET /api/pedidos`, `DELETE /api/pedidos/:id`, `GET /api/pedidos/match` |
| Propostas | `POST /api/propostas`, `GET /api/propostas`, `.../aceitar`, `.../recusar` |
| Viagens | `POST /api/viagens`, `POST /api/viagens/:id/pontos`, `.../finalizar`, `GET /api/viagens`, `GET /api/viagens/:id` |
| Admin | `GET /api/admin/overview`, `POST /api/admin/reset-senha` |

Detalhes:
- **Match** usa Haversine no SQL; raio configurável por `RAIO_MATCH_KM` (padrão 3 km); horário
  compatível dentro de ±1h.
- **Telefone** só é exposto na proposta quando `status = 'aceito'`.
- **Distância da viagem** somada por trechos consecutivos via `LAG()` + Haversine ao finalizar.
- Limpeza leve: pedidos "para agora" abertos há +3h são cancelados a cada 5 min.

---

## 7. Variáveis de ambiente (`.env.example`)

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vagao
JWT_SECRET=troque-por-um-segredo-bem-grande-aqui
PORT=3000
NODE_ENV=development
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_KEY=sua-service-role-ou-anon-key
SUPABASE_BUCKET=veiculos
GOOGLE_MAPS_API_KEY=sua-google-maps-api-key
RAIO_MATCH_KM=3
```

---

## 8. Pendências / próximos passos

- [ ] **Push** dos 2 commits para `origin/claude/leopardo-ride-sharing-me5pc6` (precisa token com escrita).
- [ ] **Abrir o PR draft** (base `main`, head `claude/leopardo-ride-sharing-me5pc6`).
- [ ] **Aplicar o `schema.sql`** no banco real do Vagão (Supabase/Postgres) — *ainda pendente
      a definição de qual banco/Storage usar.*
- [ ] Configurar Storage (bucket `veiculos`) e `GOOGLE_MAPS_API_KEY` no ambiente.

### Texto sugerido do PR
**Título:** `Pivota Leopardo para Vagão (app de carona interno)`
**Corpo:** ver seções 3–6 deste documento.

---

## 9. Como retomar numa sessão nova

Cole isto para o Claude na sessão nova (já com escrita liberada):

> "Recrie/garanta a branch `claude/leopardo-ride-sharing-me5pc6` no repo `leopardo-api`
> com o pivot Leopardo→Vagão (app de carona interno), faça o push e abra o PR draft
> contra `main`. Use o HANDOFF-VAGAO.md como referência do que cada arquivo contém."
