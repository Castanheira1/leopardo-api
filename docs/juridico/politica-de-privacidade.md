# Política de Privacidade — VAP

**Versão 1.0 — vigente desde 03/07/2026**

> **Antes de publicar:** substitua os campos entre colchetes `[ ]` pelos dados reais do
> controlador e do encarregado (DPO). Modelo alinhado à LGPD (Lei nº 13.709/2018); não
> substitui revisão jurídica. Mantenha em sincronia com `public/politica-privacidade.html`.

---

## 1. Quem é o controlador dos dados

O controlador dos dados pessoais tratados neste aplicativo é **Wanderlei Ribeiro de Castro Castanheira** (CPF 035.320.691-13), pessoa física responsável pelo VAP. Assim que a pessoa jurídica for constituída, esta política será atualizada com a razão social e o CNPJ correspondentes. O aplicativo é de
uso interno, destinado a organizar caronas entre colaboradores.

## 2. Encarregado (DPO) e contato

Para exercer seus direitos ou tirar dúvidas, fale com o Encarregado pelo Tratamento de
Dados Pessoais: **Wanderlei Ribeiro de Castro Castanheira** — **castanheira.wrc@gmail.com**.

## 3. Quais dados coletamos

| Categoria | Dados |
|---|---|
| Cadastro / identificação | Nome, matrícula, função, sexo, empresa, projeto, centro de custo, telefone (WhatsApp) e email. |
| Autenticação | Senha, armazenada apenas como *hash* bcrypt — nunca em texto. |
| Segurança da viagem | Selfie ao vivo (motorista e passageiro) e foto do veículo com placa, cada uma com data/hora e localização (GPS) do momento da captura. |
| Geolocalização | Posição GPS em tempo real durante o uso (mapa) e o traçado completo (rota) das viagens. |
| Uso do app | Caronas ofertadas, pedidos, propostas, viagens, distância percorrida e registros de acesso. |

Não coletamos dados de crianças e adolescentes nem categorias sensíveis além das imagens
necessárias à segurança das caronas.

## 4. Para que usamos (finalidades) e base legal

- **Operar as caronas** (cadastro, login, match por proximidade, contato entre as partes) —
  execução de contrato/procedimentos preliminares e legítimo interesse.
- **Segurança das viagens** (selfie ao vivo, foto do carro/placa e rota GPS que permitem
  identificar quem dirigiu, quem embarcou e o trajeto) — legítimo interesse na segurança dos
  colaboradores, com o seu **consentimento** para o uso de imagem e localização.
- **Gestão e rateio de custos** por empresa/projeto/centro de custo — legítimo interesse e
  cumprimento de obrigações contratuais.
- **Recuperação de senha e comunicação operacional** por email — execução do serviço.

## 5. Com quem compartilhamos

Seus dados **não são vendidos**. São acessíveis apenas:

- ao outro participante da carona, e somente o necessário: o telefone é revelado **apenas
  após o aceite** da proposta;
- aos administradores do seu projeto, para segurança e rateio;
- a operadores que hospedam a infraestrutura (banco de dados e armazenamento de fotos na
  Supabase; hospedagem na Render), que tratam os dados sob nossa instrução.

## 6. Por quanto tempo guardamos

As **fotos de segurança** (selfies e foto do carro) são apagadas automaticamente **após 30
dias**. Os demais dados de cadastro e o histórico de viagens são mantidos enquanto sua conta
estiver ativa e pelo prazo necessário ao cumprimento de obrigações legais e ao rateio. Você
pode solicitar a exclusão a qualquer momento (item 8).

## 7. Como protegemos

- Senhas guardadas apenas como *hash* (bcrypt).
- Acesso autenticado por token (JWT) e consultas ao banco parametrizadas.
- Fotos só por câmera ao vivo (galeria bloqueada), com carimbo de data/hora e GPS.
- Comunicação por HTTPS e limite de tentativas de login (proteção contra força bruta).
- Isolamento por projeto: colaboradores de projetos diferentes não interagem entre si.

## 8. Seus direitos (LGPD, art. 18)

Você pode, a qualquer momento: confirmar a existência de tratamento; acessar, corrigir ou
atualizar seus dados; solicitar anonimização, bloqueio ou exclusão de dados desnecessários;
pedir a portabilidade; obter informação sobre compartilhamento; e **revogar o
consentimento**. Para exercer, escreva ao Encarregado (item 2). Parte dos dados você mesmo
edita no seu perfil dentro do app.

## 9. Cookies e armazenamento local

Não usamos cookies de rastreamento ou publicidade. O app guarda no seu próprio aparelho
(armazenamento local do navegador) apenas o token de sessão e informações básicas do perfil,
para manter você conectado.

## 10. Alterações desta política

Podemos atualizar esta política. Quando houver mudança relevante, informaremos no app e, se
necessário, pediremos um novo consentimento. A versão vigente é sempre a publicada.
