# Relatório de prontidão comercial — VAP

Atualizado: 2026-07-25

## Veredito

**Núcleo pronto para piloto comercial** após o pacote “produto sem vergonha”
(escape do passageiro, TTL de viagens, CSP, jurídico CNPJ-ready, email fail-closed,
senhas padrão desativadas em produção).

Ainda **seu** passo (fora do código): abrir CNPJ, preencher placeholders legais,
publicar nas lojas (Firebase, keystore, Team ID), domínio de email verificado no Resend.

## O que já está sólido

- Fluxo ponta a ponta com testes de integração + CI
- Match / propostas / fila / double-match fechados
- Passageiro consegue encerrar viagem se o motorista sumir
- Viagens `em_andamento` abandonadas (>6h) cancelam sozinhas
- CSP ligada; JWT não aceita mais `?token=` na query
- Admin/dono com senha padrão são desativados em produção sem env
- Política/termos sem CPF público — slots para CNPJ
- `/api/health` expõe flags: db, push, email, maps

## Antes de cobrar / loja

1. Preencher `[RAZÃO SOCIAL]`, `[CNPJ]`, DPO e domínio em `public/politica-privacidade.html` + `termos-de-uso.html` (+ docs/juridico)
2. Incrementar `POLITICA_VERSAO` / `public/app.js` ao preencher
3. `EMAIL_FROM` com domínio verificado (nunca `onboarding@resend.dev` em prod)
4. `ADMIN_SENHA` + `DONO_SENHA` no Render
5. `npm run store:check` → zerar pendências de Firebase/keystore/Team ID
6. Revisão jurídica rápida dos termos

## Mantido de propósito

- Senha de 6 dígitos (PIN) + rate-limit de auth
- Finalizar viagem (km/rateio) só pelo motorista
