# VAP - Carona entre colaboradores

App interno de **carona** (estilo "mini Uber") para o ambiente de trabalho. O mesmo
usuário alterna entre **motorista** e **passageiro**, com verificação de segurança por
**foto ao vivo** e **registro de toda viagem com a rota**.

## Funcionalidades

- **Modo motorista/passageiro** no mesmo app (alternância rápida).
- **Pedir carona:** mostra sua localização (GPS), escolhe o destino no mapa, tira uma
  **selfie ao vivo** e publica o pedido.
- **Oferecer carona:** ao ativar o modo motorista, captura **selfie + foto do carro**
  (com a **placa** lida automaticamente por OCR e **editável**) e uma **TAG** manual.
  A habilitação vale o dia todo e é renovada ao **trocar de carro**.
- **Match por proximidade:** caronas e pedidos são cruzados por **origem e destino
  próximos** (Haversine) e horário compatível ("agora" ou agendado).
- **Aceite + contato:** ao aceitar a proposta, o **WhatsApp/telefone** do outro é liberado.
- **Viagem com rastreamento ao vivo:** o GPS grava a rota durante o trajeto.
- **Histórico de segurança:** toda viagem guarda a rota e as fotos (selfies + carro)
  com **data e local** — registro para proteção em caso de abuso.

## Segurança das fotos

As fotos são **capturadas ao vivo pela câmera** (`getUserMedia`), **sem opção de
anexar arquivo**. Cada foto recebe carimbo de **horário e localização**. As imagens
vão para o **Supabase Storage** e as tabelas guardam a URL + metadados.

> Câmera e GPS exigem **HTTPS** (ou `localhost` em desenvolvimento).

## Tecnologias

- **Backend:** Node.js + Express, PostgreSQL (Supabase), JWT + bcrypt, Helmet, Multer.
- **Frontend:** HTML/CSS/JS puro, **Google Maps** (mapa + Places Autocomplete),
  **Tesseract.js** (OCR de placa, via CDN).
- **Storage:** Supabase Storage (mesmo mecanismo das fotos de carro).

## Instalação

```bash
npm install
cp .env.example .env   # edite com suas credenciais
# Crie as tabelas:
psql "$DATABASE_URL" -f schema.sql
npm start              # http://localhost:3000
```

### Variáveis de ambiente

Veja `.env.example`. Destaques:
- `DATABASE_URL`, `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_BUCKET`
- `GOOGLE_MAPS_API_KEY` — chave do Google Maps (Maps JavaScript API + Places).
- `RAIO_MATCH_KM` — raio de proximidade do match (padrão 3 km).

## Usuário padrão

Após o `schema.sql`: admin **000000 / admin123** (altere em produção).

## Principais endpoints

| Área | Endpoint |
|------|----------|
| Auth | `POST /api/register`, `POST /api/login`, `GET/PATCH /api/perfil` |
| Config | `GET /api/config` (Maps key) |
| Fotos | `POST /api/fotos` (multipart, captura ao vivo) |
| Motorista | `GET /api/habilitacao/hoje`, `POST /api/habilitacao` |
| Caronas | `POST/GET /api/caronas`, `DELETE /api/caronas/:id`, `GET /api/caronas/match` |
| Pedidos | `POST/GET /api/pedidos`, `DELETE /api/pedidos/:id`, `GET /api/pedidos/match` |
| Propostas | `POST /api/propostas`, `GET /api/propostas`, `.../aceitar`, `.../recusar` |
| Viagens | `POST /api/viagens`, `POST /api/viagens/:id/pontos`, `.../finalizar`, `GET /api/viagens`, `GET /api/viagens/:id` |
| Admin | `GET /api/admin/overview`, `POST /api/admin/reset-senha` |

## Estrutura

```
├── server.js          # Ponto de entrada (Express + Postgres + Supabase Storage)
├── src/               # Backend por domínio (config, db, auth, serviços, rotas)
├── schema.sql         # Esquema do banco
├── .env.example
└── public/
    ├── index.html     # Login
    ├── registro.html  # Cadastro (com telefone)
    ├── dashboard.html # App de carona (mapa, modos, câmera, propostas, viagem)
    ├── historico.html # Histórico com rota + fotos de segurança
    ├── admin.html     # Painel admin
    ├── app.js         # Auth, Maps, câmera/OCR, utilidades
    └── style.css
```

---

Desenvolvido para facilitar caronas entre colaboradores.
