# Relatório de prontidão para comercialização — Vagão

Data: 2026-07-03 · Base: branch `claude/automated-test-commercialization-check-lumy6z`

## Resumo

O **núcleo funcional está sólido**: criei uma suíte de integração ponta-a-ponta
(47 casos) que sobe o `server.js` real contra um Postgres com o `schema.sql`
aplicado e exercita todo o fluxo (cadastro → habilitação → carona → match →
proposta → aceite → viagem com GPS → finalização), além de privacidade de
telefone, isolamento por projeto e painel admin. **Resultado: 47/47 passaram.**
O `schema.sql` também aplica de forma limpa e idempotente numa base zerada.

**Mas ainda NÃO recomendo comercializar hoje.** Há bloqueadores de segurança e de
conformidade (LGPD) que precisam ser resolvidos antes de cobrar de clientes por um
app que guarda **selfies, rota de GPS e telefone** de funcionários.

> Nota de ambiente: os testes rodaram contra um Postgres **local** (o ambiente
> bloqueia as portas 5432/6543, então não consegui falar direto com o banco
> `leopardo` de produção daqui). Isso não muda o veredito — os testes validam o
> código que roda em produção.

---

## O que passou ✅

- **Boot e healthcheck** (`/api/config`, `/`).
- **Cadastro/login** com todas as validações (senha de 6 dígitos, email, projeto,
  matrícula duplicada, credenciais erradas).
- **Autenticação JWT** barra acesso sem token / token inválido.
- **Habilitação, caronas, pedidos** com as regras de negócio (habilitação
  obrigatória para ofertar; selfie obrigatória para pedir).
- **Match por proximidade (Haversine)** casando origem e destino.
- **Propostas → aceite → viagem** criada automaticamente.
- **Privacidade de telefone**: só é revelado após o aceite (confirmado por teste).
- **Isolamento por projeto**: usuário de outro projeto não interage.
- **Viagem**: gravação de pontos, permissão restrita aos participantes,
  finalização só pelo motorista, cálculo de distância.
- **Admin**: escopo por projeto, bloqueio de não-admin.
- **SQL 100% parametrizado** — não vi risco de SQL injection.

---

## Bloqueadores para comercializar 🔴

### 1. XSS armazenado (roubo de conta) — **crítico**
Campos livres controlados pelo usuário (`nome`, `tag` do carro, `observacao`,
`destino_texto`) são inseridos direto no `innerHTML` **sem escape**, e não existe
nenhuma função de escape no front (`public/`). Exemplos:
`public/dashboard.html:1051-1065` (`cardCarona`), e vários outros pontos que
montam HTML por template string.

Como o `helmet` está com **CSP desabilitada** (`server.js:36`) e o token JWT fica
no `localStorage`, um usuário que se cadastrar com um nome como
`<img src=x onerror=...>` consegue executar script no navegador de **outro**
usuário e roubar o token → sequestro de conta. Num app de segurança, isso é
inaceitável em produção.
**Correção:** escapar toda interpolação de dados do usuário (função `escapeHtml`
ou trocar por `textContent`/nós DOM) e, de preferência, ligar uma CSP.

### 2. LGPD / base legal — **crítico (jurídico)**
O app coleta **dados pessoais sensíveis**: selfie ao vivo, rota de GPS completa e
telefone. Não há **política de privacidade, termos de uso nem tela de
consentimento** (nenhuma página em `public/` menciona isso). Comercializar
tratamento de dados pessoais no Brasil sem isso viola a LGPD.
**Correção:** política de privacidade + termos, consentimento no cadastro, e
formalizar base legal, encarregado (DPO) e política de retenção (a retenção
técnica de 30 dias das fotos já existe em `aplicarRetencaoFotos`, mas falta a
camada jurídica).

---

## Fortemente recomendado antes de vender 🟠

- **Senha fraca:** exatamente 6 dígitos numéricos (`server.js:172`) = só 1 milhão
  de combinações, e o login tem apenas um limitador **global** de 1200 req/15min
  por IP (`server.js:39`) — sem trava por conta nem bloqueio após N tentativas.
  É força-bruta-vel. Considere PIN + 2º fator, lockout por conta, ou senha forte.
- **CORS `origin: "*"`** (`server.js:40`): qualquer site pode chamar a API. Combine
  com o JWT no `localStorage` e o risco aumenta. Restrinja aos domínios oficiais.
- **Admin padrão `000000/admin123`**: trocar obrigatoriamente em produção.
- **Google Maps API key** é exposta em `/api/config` (por design): restrinja por
  domínio/HTTP referrer no Google Cloud para não virar conta de terceiros.

## Bom ter 🟡

- **CI**: rodar `npm test` (esta suíte) automaticamente a cada PR.
- Cobrir no futuro o que exige serviços externos/navegador (upload Supabase, OCR,
  push, email) — hoje fora do alcance do teste automatizado.

---

## Veredito

| Dimensão | Situação |
|---|---|
| Funcionalidade do core | ✅ Pronta (47/47) |
| Schema / deploy | ✅ Aplica limpo e idempotente |
| Segurança (XSS/auth/CORS) | 🔴 Corrigir antes |
| Conformidade LGPD | 🔴 Falta base jurídica |

**Recomendação:** o produto funciona, mas **trate os 2 bloqueadores 🔴 (XSS e
LGPD) e os itens 🟠 de autenticação antes de cobrar de clientes.** Feito isso, é
comercializável. Posso implementar as correções de XSS/CORS/senha se você quiser —
é o próximo passo natural.
