# Textos prontos — Google Play e App Store

Copie e cole nas fichas das lojas. Ajuste se o nome do projeto na empresa for diferente.

---

## Nome do app

**VAP — Conectando pessoas**

(Nome curto na home do celular: **VAP**)

---

## Descrição curta (Google Play, até 80 caracteres)

App interno de caronas entre colaboradores do mesmo projeto.

---

## Descrição completa

O VAP conecta motoristas e passageiros do mesmo projeto para compartilhar caronas de forma segura e organizada.

**Para passageiros**
- Veja caronas e motoristas disponíveis no mapa
- Solicite vaga ou envie contato quando o destino é parecido
- Acompanhe a viagem em tempo real

**Para motoristas**
- Publique sua rota e vagas disponíveis
- Receba pedidos de carona na sua região
- Gerencie propostas e passageiros

**Segurança**
- Cadastro com matrícula e validação
- Selfie e foto do veículo para identificação
- Política de privacidade e exclusão de conta no próprio app

O VAP é destinado a colaboradores autorizados do projeto. É necessário login com matrícula.

---

## Categoria

- Google Play: **Mapas e navegação** ou **Viagens e guias locais**
- App Store: **Travel** ou **Navigation**

---

## URLs obrigatórias

| Campo | URL |
|-------|-----|
| Política de privacidade | https://leopardo-api.onrender.com/politica-privacidade.html |
| Termos de uso | https://leopardo-api.onrender.com/termos-de-uso.html |
| Exclusão de conta | https://leopardo-api.onrender.com/excluir-conta.html |

---

## E-mail de suporte

Preencha com o e-mail do DPO ou suporte do projeto (o mesmo da política de privacidade).

---

## Capturas de tela (tire do app real)

Mínimo sugerido (5 telas):

1. Login / escolha de papel (motorista ou passageiro)
2. Mapa com caronas ou motoristas
3. Solicitar carona / buscar destino
4. Viagem em andamento ou histórico
5. Perfil (mostrando opção **Excluir conta**)

**Tamanhos iOS (obrigatórios):** iPhone 6,7" (1290×2796) e 6,5" (1284×2778) — use simulador Xcode ou device real.

**Android:** mínimo 2 capturas de telefone (1080×1920 ou superior).

---

## Notas para revisão da Apple (App Review Information)

```
App interno de caronas para colaboradores autorizados (login com matrícula).

Recursos nativos além do WebView:
- GPS em primeiro plano, para o mapa e para gravar a rota da viagem
- Câmera para a selfie de segurança e a foto do veículo
- Push notifications para ofertas e pedidos de carona

O app não usa localização em segundo plano: a rota é gravada enquanto a tela da
viagem está aberta. O Info.plist declara apenas remote-notification em UIBackgroundModes.

Conta de teste para revisão:
Matrícula: [PREENCHER]
Senha: [PREENCHER]
```

---

## Localização em segundo plano (Google Play)

**Responda "Não"** na pergunta sobre localização em segundo plano.

O app não declara `ACCESS_BACKGROUND_LOCATION`. O rastreamento da viagem no Android
usa um Foreground Service com notificação visível ("Rastreando sua viagem"), iniciado
com o app aberto — o que não conta como uso em segundo plano para o Play. Com isso
você **não** precisa preencher a declaração nem gravar o vídeo de demonstração.
