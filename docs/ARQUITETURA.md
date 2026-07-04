# VAP — Guia de arquitetura e desenvolvimento

Referência técnica do projeto (para quem for manter ou evoluir o código).

## What this is

**VAP** — an internal **ride-sharing** app ("mini-Uber") for coworkers. The same
user switches between **motorista** (driver) and **passageiro** (passenger). Safety is
enforced with **live camera selfies** and **full trip logging with the GPS route**.

The codebase and all domain vocabulary are in **Portuguese**. Keep identifiers and
user-facing strings in Portuguese to match the existing style.

### Core domain glossary

| Term | Meaning |
|------|---------|
| `carona` | A ride **offered** by a driver |
| `pedido` | A ride **request** from a passenger |
| `proposta` | A match/offer between the two sides, pending accept/decline |
| `habilitação` | A driver's daily "enabled" record (selfie + car photo + plate), valid for the day, renewed when the car changes |
| `viagem` | An actual trip created from an accepted `proposta`, with live GPS points |
| `match` | Pairing caronas↔pedidos by proximity (Haversine) of origin **and** destination + compatible time |

## Tech stack

- **Backend:** Node.js (**>= 22** — required, see below) + Express 4, single file
  `server.js`.
- **DB:** PostgreSQL (Supabase). Accessed directly via `pg` `Pool` using `DATABASE_URL`
  — **not** via the Supabase JS client / PostgREST. RLS is therefore not relied upon.
- **Auth:** JWT (`jsonwebtoken`, 8h expiry) + `bcrypt` password hashes.
- **Photo storage:** Supabase Storage (bucket `veiculos`), uploaded **server-side** with
  the `service_role` key via `@supabase/supabase-js`.
- **Frontend:** vanilla HTML/CSS/JS in `public/` (no build step, no framework). Loads
  **Google Maps JS API + Places** and **Tesseract.js** (plate OCR) from CDNs at runtime.
- **PWA:** `manifest.json` + `service-worker.js` (app-shell cache; API never cached).
- **Security middleware:** `helmet` (CSP disabled), `express-rate-limit`,
  `cors` (allowlist via `CORS_ORIGINS`).

## Repository layout

```
server.js            # ENTIRE backend: Express app, all routes, DB pool, Supabase upload
schema.sql           # Full DB schema (idempotent; safe to re-run). Apply manually.
package.json         # scripts: start / dev (nodemon) / test. engines: node >=22
.node-version        # pins Node 22 for Render (read by Render's build)
.env.example         # All env vars (copy to .env for local dev)
Dockerfile           # node:22-alpine (NOTE: Render uses render.yaml, not this Dockerfile)
render.yaml          # Render Blueprint — the real deploy config (node runtime)
DEPLOY-RENDER.md     # Step-by-step Render deploy guide (authoritative for deploy)
MELHORIAS_FUTURAS.md # Planned features (admin approval flow, rateio, AI per project)
README.md            # User-facing overview
docs/juridico/       # Legal documents (privacy policy, terms of use, consent term)
tests/               # End-to-end integration suite (tests/integration.test.js)
public/
  index.html         # Login + password recovery
  registro.html      # Signup (with phone, project, company, cost center)
  dashboard.html     # Main app: map, driver/passenger modes, camera, proposals, live trip
  historico.html     # Trip history with route + safety photos
  admin.html         # Admin panel (overview, password reset)
  app.js             # Shared utils: auth, fetchWithAuth, Maps loader, camera capture, OCR
  pwa.js             # Service-worker registration
  service-worker.js  # App-shell caching (fixed list; never caches /api/)
  manifest.json      # PWA manifest
  *.png              # Icons
```

`npm start` runs the server directly; `npm run dev` uses nodemon; `npm test` runs the
integration suite.

## Local development

```bash
npm install
cp .env.example .env      # fill in real values
psql "$DATABASE_URL" -f schema.sql   # create/refresh tables
npm run dev              # nodemon, http://localhost:3000
```

- **Camera (`getUserMedia`) and GPS require HTTPS or `localhost`.** They will not work
  over a plain LAN IP.
- The server **boots even without a DB or Supabase configured** — it logs a warning and
  serves pages; DB-backed routes return 500 and photo upload is disabled. Only a missing
  **`JWT_SECRET` aborts startup** (`process.exit(1)`).

> **Node 22+ is mandatory (hard crash otherwise).** `createClient` from
> `@supabase/supabase-js` initializes a `RealtimeClient` whose
> `WebSocketFactory` **throws on boot** (`Node.js NN detected without native WebSocket
> support`) on any Node **< 22**, because native `WebSocket` only exists from Node 22.
> The app doesn't even use Realtime (only Storage), but `createClient` initializes it
> regardless. This is pinned via `.node-version` (`22`), `engines` (`>=22`), and
> `NODE_VERSION=22` in `render.yaml`. If a deploy dies with "Exited with status 1" right
> after `createClient` in the stack trace, the host is on an older Node — bump it.

### Environment variables (see `.env.example`)

| Var | Required | Notes |
|-----|----------|-------|
| `JWT_SECRET` | **yes** (boot fails without it) | min 32 chars |
| `DATABASE_URL` | yes (for any data) | On Render use the Supabase **Session pooler** (IPv4), not the direct IPv6 host |
| `SUPABASE_URL` | for photos | |
| `SUPABASE_KEY` | for photos | use the **`service_role`** key (server-only) |
| `SUPABASE_BUCKET` | no (default `veiculos`) | must be a **public** bucket |
| `GOOGLE_MAPS_API_KEY` | for the map | exposed to the front via `GET /api/config`; restrict by domain in Google Cloud. Needs **Maps JavaScript API** + **Places API** |
| `CORS_ORIGINS` | no | allowlist of external origins; empty = same-origin only |
| `AUTH_RATE_MAX` | no (default `20`) | login/register/recovery attempts per IP / 15 min |
| `RAIO_MATCH_KM` | no (default `3`) | match proximity radius in km |
| `PORT` | no (default `3000`) | |
| `NODE_ENV` | — | when `production`, Postgres SSL is enabled with `rejectUnauthorized: false` |

## Database

Schema lives entirely in `schema.sql` (there is **no migration tool** — apply the file
manually with `psql`). It is **idempotent**: it `DROP`s the carona-flow tables and
recreates them, while reference tables use `CREATE TABLE IF NOT EXISTS`.

> **Ordering gotcha (already fixed, keep it that way):** `usuarios` gains FK columns
> (`empresa_id`, `projeto_id`, `admin_projeto_id`) via `ALTER TABLE`. Those ALTERs must
> run **after** the `projetos` and `empresas` tables are created, otherwise a *fresh*
> setup fails with `relation "empresas" does not exist`. If you add new FK columns to
> `usuarios`, place them in the same later block, not next to the `CREATE TABLE usuarios`.

Tables: `usuarios`, `habilitacoes_motorista`, `caronas`, `pedidos`, `propostas`,
`viagens`, `viagem_pontos`, `localizacoes_online`, `projetos`, `empresas`, `contratos`,
`admin_chamados`.

- Seed admin: matrícula **`000000`** / password **`admin123`** (`is_admin = TRUE`).
  Change it in production. Registering with matrícula `000000` also flags admin.
- `localizacoes_online` is one row per user (upsert on `usuario_id`) for the live map.
- Lat/lng are `NUMERIC(10,6)`. Status fields use `CHECK` constraints — match the
  allowed values when writing new code (e.g. carona: `ativa/concluida/cancelada`;
  pedido: `aberto/atendido/cancelado`; proposta: `pendente/aceito/recusado`;
  viagem: `em_andamento/concluida/cancelada`).

## Backend conventions (`server.js`)

- **Single-file Express app.** Routes are grouped by section banners
  (`/* === AUTH === */`, `/* === CARONAS === */`, etc.). Keep that structure.
- **Auth middleware:** `verificarAuth` reads a Bearer token (or `?token=` query param for
  things like image URLs) and sets `req.user` = `{ id, matricula, is_admin }`.
  `verificarAdmin` gates admin routes.
- **All queries are parameterized** (`$1, $2, ...`). Never interpolate user input into SQL.
  The one templated SQL helper, `haversine(latCol, lngCol, pLat, pLng)`, only ever
  receives **column names and `$n` placeholders** as arguments — keep it that way.
- **Errors:** routes `try/catch`, `console.error` the detail, and return
  `res.status(5xx).json({ error: "..." })` with a Portuguese message. There is a global
  error handler at the bottom.
- **Photos:** `uploadToSupabase(file, pasta)` uploads to the bucket and returns the public
  URL. `POST /api/fotos` accepts multipart (memory storage, 6 MB limit, images only) and
  files into `selfies/` / `carros/` / `outros/` subfolders.
- **Matching:** `/api/caronas/match` and `/api/pedidos/match` use the Haversine distance
  on **both** origin and destination `<= RAIO_KM`, plus a ±1h time window when both
  horários are set; ordered by `dist_origem + dist_destino`.
- **Contact privacy:** phone numbers are only returned once a `proposta` is `aceito`
  (see the `CASE WHEN ... 'aceito'` columns in `GET /api/propostas`).
- A `setInterval` every 5 min cancels stale "now" `pedidos` (open, no horário, > 3h old).

### API surface (all `/api/...`)

Public: `GET /api/config`, `GET /api/projetos`, `POST /api/register`, `POST /api/login`,
`POST /api/recuperar-senha` (matrícula + cadastered phone → new password, no email/SMS),
`POST /api/admin/chamados`.

Authenticated: `GET/PATCH /api/perfil`, `POST /api/fotos`,
`GET /api/habilitacao/hoje`, `POST /api/habilitacao`,
`POST/GET /api/caronas`, `DELETE /api/caronas/:id`, `GET /api/caronas/match`,
`POST/GET /api/pedidos`, `DELETE /api/pedidos/:id`, `GET /api/pedidos/match`,
`POST/GET /api/propostas`, `POST /api/propostas/:id/aceitar|recusar`,
`POST /api/viagens`, `POST /api/viagens/:id/pontos`, `POST /api/viagens/:id/finalizar`,
`GET /api/viagens`, `GET /api/viagens/:id`, `GET /api/viagens/:id/localizacao`,
`POST/DELETE /api/localizacao`, `GET /api/motoristas-online`.

Admin: `GET /api/admin/overview`, `POST /api/admin/reset-senha` (resets to `123456`),
`GET /api/rateio` (active users in last 40 days, grouped by project/company/cost center).

## Frontend conventions (`public/`)

- No framework, no bundler. Shared helpers live in `app.js` and are loaded as plain
  `<script>`s. Reuse them instead of re-implementing:
  - `checkAuth(adminOnly)`, `logout()`, `fetchWithAuth(url, opts)` (auto Bearer header,
    handles 401 → logout).
  - `escapeHtml(v)` / `esc(v)` — escape user data before injecting into `innerHTML`.
  - `carregarMaps()` — lazy-loads Google Maps using the key from `/api/config`.
  - `capturarFoto({ tipo, facing, ocrPlaca, titulo })` — **live camera capture only**
    (no file attach by design, for safety); returns `{ url, lat, lng, em, placa? }`,
    stamping each photo with time + GPS, and running plate OCR (`lerPlaca`) via Tesseract.
  - `obterLocalizacao()`, `linkWhatsApp(tel)`, `fmtData`, `fmtHorario`.
- Token + user are stored in `localStorage` (`token`, `user`).
- **Service worker:** the cache (`SHELL`) is a **fixed list** and the version constant is
  `VERSION` in `service-worker.js`. `/api/` and cross-origin (Maps/Supabase/CDN) requests
  are never cached. **If you add a new page or static asset that must work offline, add it
  to `SHELL` and bump `VERSION`.**

## Deployment (Render)

`render.yaml` is a Blueprint that creates a **node** web service
(`buildCommand: npm install`, `startCommand: npm start`, healthcheck `/api/config`,
`branch: main`). The **`Dockerfile` is not used by this path** — it exists for other
container hosts.

`render.yaml` auto-provides `NODE_ENV=production`, a generated `JWT_SECRET`,
`SUPABASE_BUCKET=veiculos`, `RAIO_MATCH_KM=3`. The secrets to fill in the Render
dashboard (`sync: false`): `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_KEY`,
`GOOGLE_MAPS_API_KEY`. See **`DEPLOY-RENDER.md`** for the full walkthrough (including the
critical "use the Session pooler, not the direct IPv6 connection" note and creating the
public `veiculos` Storage bucket). The schema must be applied to the DB separately.

## Conventions for changes

- Match the existing **Portuguese** naming and the single-file backend structure; don't
  introduce a framework, build step, or ORM without being asked.
- Keep SQL parameterized; keep status strings within the existing `CHECK` sets.
- After backend edits, smoke-test with `JWT_SECRET=test node server.js` and hit
  `GET /api/config` / `GET /` (boots without a DB). For schema edits, validate against a
  throwaway Postgres with `psql -v ON_ERROR_STOP=1 -f schema.sql`.
- **Known open items** (`MELHORIAS_FUTURAS.md`): admin approval workflow (the
  `admin_chamados` table + `POST /api/admin/chamados` exist; approval endpoint does not),
  automated per-company rateio/billing, per-project data isolation (today users from
  different `projeto_id` can see each other), and an in-app admin assistant.
