# Testes automatizados — VAP

Suíte de **integração ponta-a-ponta** que sobe o `server.js` real e exercita as
rotas HTTP contra um Postgres com o `schema.sql` aplicado. Sem framework nem
dependências novas (usa `fetch`/`assert`/`child_process` nativos do Node 22).

## Rodar

Precisa de um Postgres de **teste** (nunca o de produção) com o schema aplicado.

**Opção A — automático (sobe um Postgres local e descartável):**

```bash
npm run test:pg
```

Requer os binários do PostgreSQL (`initdb`/`pg_ctl`) instalados na máquina.
Cria um cluster efêmero em `/tmp`, aplica o `schema.sql`, roda a suíte e no fim
derruba tudo. Não toca em nenhum banco existente.

**Opção B — contra um banco que você já tem:**

```bash
DATABASE_URL='postgresql://user:senha@host:5432/vagao_test' npm test
```

O banco precisa ter o `schema.sql` aplicado (tabelas + projetos-semente
`S11D/SALOBO/CARAJAS/SOSSEGO` + admin `000000/admin123`).

## O que é coberto (47 casos)

- **Healthcheck público:** `/api/config`, `/`, `/api/projetos`.
- **Cadastro/login:** sucesso, senha fora de 6 dígitos, email inválido, projeto
  inexistente, matrícula duplicada, senha errada, matrícula inexistente.
- **Auth middleware:** rota protegida sem token e com token inválido → 401.
- **Perfil:** ler e atualizar.
- **Habilitação do motorista:** ativar, validação de placa, consulta do dia.
- **Caronas:** exigência de habilitação, criação, listagem.
- **Pedidos:** exigência de selfie, criação, listagem.
- **Match (Haversine):** carona↔pedido por proximidade de origem e destino.
- **Isolamento por projeto:** usuário de outro projeto não interage.
- **Propostas:** criação, aceite, criação automática da viagem.
- **Privacidade:** telefone só aparece **depois** do aceite.
- **Viagem:** gravação de pontos GPS, permissão (só participantes), finalização
  com cálculo de distância.
- **Localização ao vivo:** coordenadas válidas/ inválidas.
- **Admin:** login, bloqueio de não-admin, overview/métricas/rateio/segurança.

> **Não coberto** (precisa de serviços externos / navegador): upload real de
> fotos ao Supabase Storage, captura pela câmera + OCR de placa, envio de push
> (VAPID), envio de email de recuperação (Resend) e o front-end no browser.
