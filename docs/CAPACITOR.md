# Capacitor — shell nativo (Android/iOS)

Este projeto ganhou um wrapper [Capacitor](https://capacitorjs.com) em volta do
PWA existente em `public/`. Nada no backend (`server.js`) ou no frontend mudou —
o Capacitor só empacota os mesmos arquivos numa WebView nativa e dá acesso a
APIs nativas quando forem adicionadas (push, GPS em segundo plano, câmera etc.).

## O que foi adicionado

- `capacitor.config.ts` — configuração do app (`appId: com.vap.carona`, `appName: VAP`).
- `android/` — projeto nativo Android (Gradle). Abra com Android Studio.
- `ios/` — projeto nativo iOS (Xcode + Swift Package Manager, sem CocoaPods).
  Só pode ser aberto/buildado num Mac com Xcode.
- Scripts novos no `package.json`: `npm run cap:sync`, `npm run cap:android`,
  `npm run cap:ios`.

Os diretórios `android/` e `ios/` já vieram com `.gitignore` próprio (gerado
pelo Capacitor) que exclui build outputs, `Pods/`, `DerivedData/` e as cópias
de `public/` copiadas para dentro de cada projeto nativo (`.../assets/public`,
`.../App/public`) — **não edite os arquivos dentro dessas pastas `public`
copiadas**, elas são sobrescritas a cada `cap sync`. Edite sempre a `public/`
da raiz.

## Dois modos de carregar o app

Configurado em `capacitor.config.ts` via variável de ambiente
`CAPACITOR_SERVER_URL`, lida no momento do `cap sync`/build:

1. **Sem a variável (padrão):** o app embarca os arquivos de `public/` como
   assets locais dentro do APK/IPA. Útil para inspecionar o shell nativo, mas
   as chamadas `fetch` do `app.js` são relativas (`/api/...`) e **não
   funcionam** sem um backend acessível a partir do dispositivo — ainda não
   configuramos uma URL base absoluta para produção.
2. **`CAPACITOR_SERVER_URL=https://<seu-backend> npx cap sync`:** o app carrega
   a URL do backend publicado diretamente na WebView, como um navegador
   normal. Como o front e a API continuam no mesmo domínio, todo o código
   existente (`fetchWithAuth`, service worker, cookies/localStorage) funciona
   **sem nenhuma mudança de código**. Este é o modo recomendado para os
   primeiros testes em dispositivo real.

Exemplo:

```bash
CAPACITOR_SERVER_URL=https://vagao.onrender.com npx cap sync
npm run cap:android   # abre no Android Studio
npm run cap:ios       # abre no Xcode (requer macOS)
```

## Build local

- **Android:** requer Android Studio / Android SDK instalados (não estão
  disponíveis neste ambiente de execução remoto — só foi possível gerar os
  arquivos do projeto e rodar `npx cap doctor`, que confirmou a configuração
  válida).
- **iOS:** requer macOS + Xcode. Não foi possível validar o build aqui por
  não haver Xcode neste ambiente Linux.

## Próximos passos (fora deste scaffold)

Conforme o plano faseado discutido: depois de validar que o app abre e fala
com o backend nos dois modos acima, os próximos incrementos são, nesta ordem:

1. Push nativo (`@capacitor/push-notifications`, FCM/APNs) como
   complemento ao Web Push que já existe (`server.js`, `push_subscriptions`) —
   necessário para notificações confiáveis com o app **encerrado** pelo SO,
   principalmente no iOS.
2. Geolocalização em segundo plano (`@capacitor/geolocation` +
   plugin de background location), habilitada só enquanto o motorista está
   com o toggle "disponível" ligado.
3. Publicação nas lojas (Play Store / App Store): ícones, splash screen,
   política de privacidade (já existe em `public/politica-privacidade.html`),
   contas de desenvolvedor.
