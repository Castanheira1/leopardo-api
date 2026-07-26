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

## Antes de usar em produção

1. ~~Preencher os campos entre colchetes~~ **Feito** (controlador pessoa física + DPO preenchidos em 16/07/2026; atualizar para razão social/CNPJ quando a PJ for constituída). Eram: razão social,
   CNPJ, endereço, nome/e-mail do Encarregado (DPO), cidade/UF do foro e canal de suporte.
2. **Revisão jurídica** por advogado(a) — estes são modelos adaptados ao VAP, não
   parecer legal.
3. Sempre que alterar um documento, **incremente a versão** (hoje `1.0`) e a data de
   vigência, para que novos aceites fiquem rastreáveis.
