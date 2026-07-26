# Documentos jurídicos — VAP

Documentos legais do aplicativo de caronas VAP, reunidos aqui para leitura e
manutenção. Estão em formato Markdown (renderizam direto no GitHub).

## Índice

| Documento | Para que serve |
|---|---|
| [Política de Privacidade](politica-de-privacidade.md) | Como coletamos, usamos, compartilhamos e protegemos os dados pessoais (LGPD). |
| [Termo de Uso](termo-de-uso.md) | Regras de uso do app: responsabilidades, condutas proibidas, suspensão, limitação de responsabilidade, intermediação. |
| [Termo de Consentimento](termo-de-consentimento.md) | O aceite formal do usuário para o tratamento de dados (selfie, foto do veículo, GPS, telefone). |

## Como estão ligados ao app

- O **checkbox de aceite no cadastro** e o **portão de consentimento** (para contas
  antigas) registram data, hora e versão nos campos `politica_aceita_em` e
  `politica_versao` da tabela `usuarios`.
- A Política de Privacidade também é servida no app em
  [`public/politica-privacidade.html`](../../public/politica-privacidade.html) — ao
  alterar o conteúdo aqui, mantenha os dois em sincronia.
- Os Termos de Uso públicos estão em
  [`public/termos-de-uso.html`](../../public/termos-de-uso.html).

## Versões vigentes (sincronizar HTML + MD)

| Documento | Versão | Vigência |
|---|---|---|
| Política de Privacidade | 1.2 | 25/07/2026 |
| Termo de Uso | 1.4 | 25/07/2026 |
| Termo de Consentimento | 1.2 | 25/07/2026 |

A constante `POLITICA_VERSAO` em `public/app.js` e o campo `politica_versao` no
cadastro (`public/registro.html`) devem permanecer alinhados à Política (hoje `1.2`).

## Antes de usar em produção

1. **Preencher os placeholders** em HTML e Markdown:
   `[RAZÃO SOCIAL]`, `[CNPJ]`, `[ENDEREÇO]`, `[NOME DO DPO]` / `[DPO]`, `[DOMINIO]`
   (e-mails `contato@[DOMINIO]` e `dpo@[DOMINIO]`).
2. **Nunca publicar CPF** de pessoa física nos documentos legais ou no app — use
   apenas CNPJ da pessoa jurídica.
3. Ao preencher ou alterar o conteúdo, **incremente** `POLITICA_VERSAO` e a versão
   nos HTML/MD correspondentes, e atualize `public/app.js` + `public/registro.html`
   para forçar novo aceite rastreável.
4. **Revisão jurídica** por advogado(a) — estes são modelos adaptados ao VAP, não
   parecer legal. A revisão continua obrigatória antes do uso comercial.
