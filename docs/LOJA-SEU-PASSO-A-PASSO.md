# Publicar o VAP — o que já está pronto e o que é com você

App **Capacitor** (Android + iOS) com bundle local, API em produção e documentação jurídica.

| | |
|---|---|
| **App ID** | `com.vap.carona` |
| **Nome no celular** | VAP |
| **Nome na loja** | VAP — Conectando pessoas |
| **Versão inicial** | 1.0 (build 1) |
| **API** | https://leopardo-api.onrender.com |

Verificação automática: `npm run store:check`

---

## Já está pronto no repositório (não precisa refazer)

- Projetos nativos **Android** (`android/`) e **iOS** (`ios/`) com Capacitor 8.4
- **Ícones e splash** em todos os tamanhos (fonte: `assets/icon-only.png`)
- **Permissões** declaradas: câmera, GPS (incl. background), push, foreground service
- **Excluir conta** no app (Perfil) + página web `excluir-conta.html`
- **Política de privacidade** e **termos de uso** hospedados na API
- **Privacy Manifest** iOS (`PrivacyInfo.xcprivacy`) — obrigatório desde 2024
- **Push no backend** (FCM HTTP v1 + Web Push VAPID)
- **CI** gera APK/AAB Android no GitHub Actions
- **App Links / Universal Links** configurados no código (falta só preencher SHA-256 e Team ID nos arquivos `.well-known`)
- Guia técnico completo: `docs/PUBLICAR-LOJAS.md`
- Textos da ficha da loja: `store/listagem-lojas.md`

---

## O que depende de você (ordem sugerida)

### Fase 1 — Contas (você disse que vai fazer)

| # | Tarefa | Custo | Onde |
|---|--------|-------|------|
| 1 | Conta **Google Play Console** | US$ 25 (único) | https://play.google.com/console |
| 2 | Conta **Apple Developer** | US$ 99/ano | https://developer.apple.com |
| 3 | **Mac** com Xcode (para iOS) | — | Emprestado, nuvem (MacinCloud) ou CI macOS |

Sem Mac não dá para enviar o `.ipa` à App Store.

---

### Fase 2 — Firebase e push (Android + iOS)

| # | Tarefa | Detalhe |
|---|--------|---------|
| 4 | Criar projeto **Firebase** | Ver `store/firebase/README.md` |
| 5 | Baixar `google-services.json` | Copiar para `android/app/google-services.json` |
| 6 | Baixar `GoogleService-Info.plist` | Copiar para `ios/App/App/` e marcar target **App** no Xcode |
| 7 | Service account JSON no **Render** | Variável `FIREBASE_SERVICE_ACCOUNT_JSON` |
| 8 | **APNs Auth Key** (.p8) no Firebase | Apple Developer → Keys → subir no Firebase Cloud Messaging |

**Importante iOS:** hoje o app manda token APNs cru; o backend precisa de token **FCM** no iPhone. Depois do Firebase no Xcode, instale `@capacitor-firebase/messaging` ou integre o SDK no `AppDelegate.swift` (passo a passo em `docs/PUBLICAR-LOJAS.md` §7). Sem isso, push funciona no Android mas **não no iPhone**.

---

### Fase 3 — Android (pode fazer no Windows/Linux)

| # | Tarefa | Comando / ação |
|---|--------|----------------|
| 9 | Instalar dependências e sincronizar | `npm install && npm run cap:prepare` |
| 10 | Gerar **keystore** (guarde para sempre!) | `keytool -genkey -v -keystore vap-release.jks -alias vap -keyalg RSA -keysize 2048 -validity 10000` |
| 11 | Extrair SHA-256 | `npm run store:sha256` → colar em `public/.well-known/assetlinks.json` |
| 12 | Deploy do backend | Para o `assetlinks.json` atualizado ficar online |
| 13 | Abrir Android Studio | `npm run cap:android` |
| 14 | Gerar **AAB assinado** | Build → Generate Signed Bundle → enviar na Play Console |
| 15 | Formulário **Background location** | Play Console — justificativa + vídeo curto (texto em `store/listagem-lojas.md`) |
| 16 | **Segurança dos dados** | Marcar localização, fotos, contato (ver `docs/PUBLICAR-LOJAS.md` §6) |

---

### Fase 4 — iOS (precisa de Mac)

| # | Tarefa | Ação |
|---|--------|------|
| 17 | Abrir Xcode | `npm run cap:ios` |
| 18 | **Signing & Capabilities** | Selecionar seu Team (conta Apple Developer) |
| 19 | Team ID no AASA | Trocar `PREENCHER_TEAM_ID` em `public/.well-known/apple-app-site-association` e fazer deploy |
| 20 | **Archive** | Product → Archive → Distribute → App Store Connect |
| 21 | Criar app no **App Store Connect** | Bundle `com.vap.carona` |
| 22 | **App Privacy** | Localização, fotos, contato — sem rastreamento de ads |
| 23 | Conta de **teste** para revisão | Matrícula/senha nas notas do revisor (`store/listagem-lojas.md`) |

---

### Fase 5 — Ficha das duas lojas

| # | Tarefa |
|---|--------|
| 24 | Tirar **screenshots** (login, mapa, pedido, viagem, perfil) |
| 25 | Copiar textos de `store/listagem-lojas.md` |
| 26 | URL da política de privacidade nas duas lojas |
| 27 | Garantir backend **acordado** durante a revisão (Render free “dorme” — considere plano pago temporário) |

---

## Comandos úteis

```bash
npm install
npm run cap:prepare      # cap sync
npm run store:check      # lista o que falta
npm run store:sha256     # SHA-256 do keystore → assetlinks.json
npm run cap:android      # abre Android Studio
npm run cap:ios          # abre Xcode (Mac)
```

---

## Resumo visual

```
[VOCÊ] Contas Play + Apple
   ↓
[VOCÊ] Firebase + google-services.json + GoogleService-Info.plist + APNs key
   ↓
[VOCÊ] Keystore Android + SHA-256 no assetlinks + deploy backend
   ↓
[VOCÊ] AAB assinado → Play Console
   ↓
[VOCÊ] Mac + Xcode + Team ID no AASA + Archive → App Store Connect
   ↓
[VOCÊ] Screenshots + questionários de privacidade + enviar para revisão
```

O código do app, permissões, ícones, jurídico e estrutura nativa **já estão prontos**. O que bloqueia a publicação são credenciais, builds assinados e o preenchimento das fichas nas lojas.
