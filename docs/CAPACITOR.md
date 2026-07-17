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

## Isolamento nativo × PWA (já no código)

O front detecta a plataforma com `Capacitor.isNativePlatform()` (`public/platform.js`):

| Recurso | PWA (navegador) | App nativo (Capacitor) |
|---|---|---|
| Coordenadas na viagem | HTTP poll (`setInterval`) | Socket.io + fallback poll lento |
| Push | Web Push (VAPID + SW) | `@capacitor/push-notifications` → FCM/APNs |
| GPS com tela apagada | limitação do browser | Foreground Service (`TripTracking`) |
| Buffer de rota offline | Preferences → `localStorage` | Preferences (nativo) |

### Ativar push nativo de ponta a ponta

1. Crie projeto no Firebase, baixe `android/app/google-services.json`.
2. No Render, defina `FCM_SERVER_KEY` (Cloud Messaging → Server key).
3. `npx cap sync android` e rebuild do APK/AAB.
4. iOS: certificados APNs no Firebase + capabilities Push no Xcode.

### Rebuild nativo após mudanças

```bash
npm install
npx cap sync
```
