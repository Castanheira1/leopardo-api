# Publicar o VAP na Google Play e na App Store

Guia prático para a **primeira publicação**. O app é um shell Capacitor que carrega o
backend publicado (`https://leopardo-api.onrender.com`). App ID: **`com.vap.carona`**.

---

## 0. O que já está pronto no repositório

- **`capacitor.config.ts`**: bundle local por padrão (sem `server.url` = não é só web-frame).
  A API é chamada em `https://leopardo-api.onrender.com` quando o app é nativo.
  Dev remoto: `CAPACITOR_SERVER_URL=... npx cap sync`.
- **Permissões nativas declaradas** (sem elas as lojas rejeitam / o recurso trava):
  - Android: `CAMERA`, localização fine/coarse/**background**, `FOREGROUND_SERVICE(_LOCATION)`,
    `POST_NOTIFICATIONS`, `INTERNET`, `VIBRATE` + serviço `TripTrackingService`.
  - iOS: câmera, location when-in-use + always (texto de uso), `UIBackgroundModes`
    location + remote-notification, `ITSAppUsesNonExemptEncryption=false`.
- **Excluir conta** no app (Perfil → Excluir conta) — exigência das lojas.
- **Documentos jurídicos publicados** (URLs exigidas pelas lojas):
  - Política de Privacidade: `https://leopardo-api.onrender.com/politica-privacidade.html`
  - Termos de Uso: `https://leopardo-api.onrender.com/termos-de-uso.html`
- Ícones em `public/` (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`).
- **Ícones e splash NATIVOS gerados** em todos os tamanhos exigidos pelas lojas
  (38 Android + 7 iOS), a partir de `assets/icon-only.png` (1024×1024) e
  `assets/splash.png` / `assets/splash-dark.png` (2732×2732, logo VAP em fundo
  preto). Para regerar (só se o logo mudar): `npx capacitor-assets generate`.
  Atenção: a ferramenta tenta reescrever o `public/manifest.json` do PWA
  apontando para uma pasta `icons/` na raiz — reverta o manifest
  (`git checkout -- public/manifest.json`) e apague `icons/` se acontecer.
- **Vínculo domínio ↔ app** servido pelo backend em `/.well-known/` (o
  `apple-app-site-association` sai com `Content-Type: application/json`, como a
  Apple exige). Falta preencher com os dados que só existem depois das contas:
  1. Android — `public/.well-known/assetlinks.json`: após gerar o keystore, rode
     `keytool -list -v -keystore vap-release.jks -alias vap` e cole o SHA-256 em
     `sha256_cert_fingerprints` (formato `AA:BB:...`).
  2. iOS — `public/.well-known/apple-app-site-association`: troque
     `PREENCHER_TEAM_ID` pelo Team ID da conta Apple Developer.

---

## 1. Pré-requisitos (contas e ferramentas)

| Item | Android | iOS |
|---|---|---|
| Conta | Google Play Console — **US$ 25**, pagamento único | Apple Developer — **US$ 99/ano** |
| Ferramenta de build | Android Studio (Windows/Mac/Linux) | **Xcode — só roda em Mac** |
| Chave de assinatura | Keystore `.jks` (você gera) | Certificado + provisioning (Xcode gerencia) |

> Sem um Mac não é possível gerar o build de iOS. Alternativas: um Mac emprestado/na
> nuvem (ex.: MacinCloud), ou um serviço de CI com macOS (Codemagic, EAS, GitHub Actions
> macOS runner).

---

## 2. Gerar os projetos nativos atualizados

No repositório, com Node instalado:

```bash
npm install
npx cap sync          # copia config + plugins para android/ e ios/
```

Para trocar o backend (se mudar de host):

```bash
CAPACITOR_SERVER_URL=https://novo-host npx cap sync
```

---

## 3. Android — gerar o AAB assinado

1. Gere um keystore (**uma vez** — guarde bem, sem ele você não atualiza o app):
   ```bash
   keytool -genkey -v -keystore vap-release.jks -alias vap -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Abra o projeto: `npx cap open android` (abre o Android Studio).
3. Em `android/app/build.gradle`, a cada versão nova aumente **`versionCode`** (inteiro) e
   ajuste **`versionName`** (ex.: `"1.0"` → `"1.1"`). Hoje: `versionCode 1`, `versionName "1.0"`.
4. **Build → Generate Signed Bundle / APK → Android App Bundle (.aab)**, selecione o keystore.
5. No **Google Play Console**: criar app → *Produção* → enviar o `.aab`.

---

## 4. iOS — gerar e enviar (precisa de Mac)

1. `npx cap open ios` (abre o Xcode).
2. Em **Signing & Capabilities**, selecione seu *Team* (conta Apple Developer).
3. Ajuste **Version** (marketing) e **Build** (número) a cada envio.
4. **Product → Archive → Distribute App → App Store Connect**.
5. No **App Store Connect**: criar o app com o bundle `com.vap.carona`, preencher a ficha e
   enviar para revisão.

---

## 5. Ficha da loja (os dois)

- **Nome:** VAP — Conectando pessoas
- **Descrição curta:** App interno de caronas entre colaboradores.
- **Categoria:** Viagens / Transporte.
- **URL da Política de Privacidade:** `https://leopardo-api.onrender.com/politica-privacidade.html`
- **Capturas de tela:** exigidas (telefone; iPhone 6.7" e 6.5" para iOS). Tire das telas
  reais do app (login, mapa, solicitar carona, histórico).
- **Ícone:** 512×512 (Play) e 1024×1024 (App Store) — gerar a partir de `logo-vap.png`.

---

## 6. Questionário de dados (responder conforme a Política de Privacidade)

**Coletamos e por quê:** identificação (nome, matrícula, email, telefone), localização
(GPS, em primeiro plano), fotos (selfie + veículo, segurança da viagem), uso do app.
**Compartilhamento:** somente com o outro participante da carona, administradores do projeto
e operadores de infraestrutura (Supabase, Render). **Não vendemos dados.** **Retenção:**
fotos de segurança apagadas em 30 dias.

- **Google Play → Segurança dos dados:** marque coleta de *Localização aproximada e precisa*,
  *Fotos*, *Informações pessoais* (nome, email, telefone), *Atividade no app*. Dados
  criptografados em trânsito (HTTPS): **sim**. Usuário pode pedir exclusão: **sim**
  (no app: Perfil → Excluir conta; também via DPO).
- **Apple → App Privacy:** *Location*, *User Content (Photos)*, *Contact Info*, *Identifiers/
  Usage* — vinculados à identidade do usuário; uso: funcionalidade do app. Sem rastreamento
  de anúncios.

---

## 7. Pontos de atenção

- **Localização em segundo plano (já no código):** o app declara
  `ACCESS_BACKGROUND_LOCATION` + `FOREGROUND_SERVICE_LOCATION` (Android) e
  *Always* + `UIBackgroundModes=location` (iOS) porque o **rastreio ao vivo da
  viagem** precisa continuar com a tela apagada. No **Google Play Console** preencha
  a declaração de *Background location* (justificativa: segurança da carona /
  acompanhamento motorista–passageiro; ideal: vídeo curto mostrando a notificação
  “Rastreando sua viagem”). Na Apple, explique o mesmo no App Review notes.
- **Push nativo (FCM HTTP v1):** a API legada `fcm/send` foi desligada em 2024.
  Configure no Render `FIREBASE_SERVICE_ACCOUNT_JSON` (JSON da service account do
  Firebase) e coloque `android/app/google-services.json` no projeto nativo.
  Web Push (VAPID) no PWA continua independente.
- **iOS Privacy Manifest:** `ios/App/App/PrivacyInfo.xcprivacy` (UserDefaults etc.)
  — obrigatório no upload ao App Store Connect desde 2024.
- **App tipo "webview" / 4.2:** o VAP usa bundle local + API HTTPS + recursos nativos
  (câmera, GPS, foreground service, push). Se a Apple questionar, cite isso.
- **Backend no Render (plano free) "dorme"**: cold start — prefira plano que não hiberne
  durante a revisão da loja.
- **Guarde o keystore Android** e as credenciais Apple.

---

## 8. Checklist rápido

- [ ] `npm install && npx cap sync` rodados sem erro
- [ ] Ícones 512 (Play) e 1024 (App Store) gerados
- [ ] Capturas de tela tiradas
- [ ] URL da política preenchida nas duas lojas
- [ ] Questionário de dados respondido (seção 6)
- [ ] Android: `versionCode`/`versionName` atualizados, AAB assinado
- [ ] Android: `google-services.json` + `FIREBASE_SERVICE_ACCOUNT_JSON` no backend
- [ ] Android: `assetlinks.json` com SHA-256 real do keystore
- [ ] Android Play: formulário de *Background location* preenchido
- [ ] iOS: `PrivacyInfo.xcprivacy` no target (já no repo)
- [ ] iOS: `apple-app-site-association` com Team ID real
- [ ] iOS: Version/Build atualizados, archive enviado
- [ ] Backend de produção acordado e respondendo antes da revisão
