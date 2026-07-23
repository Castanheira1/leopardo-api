# Arquivos Firebase (não commitar)

Coloque aqui temporariamente ao configurar; depois copie para os projetos nativos.

| Arquivo | Destino |
|---------|---------|
| `google-services.json` | `android/app/google-services.json` |
| `GoogleService-Info.plist` | `ios/App/App/GoogleService-Info.plist` (arrastar no Xcode no target **App**) |

## Passos

1. [Firebase Console](https://console.firebase.google.com) → criar projeto (ex.: `vap-carona`)
2. Adicionar app **Android** — package `com.vap.carona` → baixar `google-services.json`
3. Adicionar app **iOS** — bundle `com.vap.carona` → baixar `GoogleService-Info.plist`
4. Firebase → Project settings → Service accounts → **Generate new private key**
5. No Render (backend): variável `FIREBASE_SERVICE_ACCOUNT_JSON` = conteúdo do JSON (uma linha)
6. Apple Developer → Keys → criar **APNs Auth Key** (.p8) → subir no Firebase → Cloud Messaging → Apple app

Sem o passo 6, push no **iPhone não funciona** (Android sim).
