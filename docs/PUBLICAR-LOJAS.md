# Publicar o VAP na Google Play e na App Store

Guia prático para a **primeira publicação**. O app é um shell Capacitor que carrega o
backend publicado (`https://leopardo-api.onrender.com`). App ID: **`com.vap.carona`**.

---

## 0. O que já está pronto no repositório

- **`capacitor.config.ts`** aponta para o backend de produção por padrão.
- **Permissões nativas declaradas** (sem elas as lojas rejeitam / o recurso trava):
  - Android (`android/app/src/main/AndroidManifest.xml`): `CAMERA`, `ACCESS_FINE_LOCATION`,
    `ACCESS_COARSE_LOCATION`, `INTERNET`, `VIBRATE`.
  - iOS (`ios/App/App/Info.plist`): `NSCameraUsageDescription`,
    `NSLocationWhenInUseUsageDescription`, `ITSAppUsesNonExemptEncryption=false`.
- **Documentos jurídicos publicados** (URLs exigidas pelas lojas):
  - Política de Privacidade: `https://leopardo-api.onrender.com/politica-privacidade.html`
  - Termos de Uso: `https://leopardo-api.onrender.com/termos-de-uso.html`
- Ícones em `public/` (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`).

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
  criptografados em trânsito (HTTPS): **sim**. Usuário pode pedir exclusão: **sim** (via DPO).
- **Apple → App Privacy:** *Location*, *User Content (Photos)*, *Contact Info*, *Identifiers/
  Usage* — vinculados à identidade do usuário; uso: funcionalidade do app. Sem rastreamento
  de anúncios.

---

## 7. Pontos de atenção

- **Localização é só em primeiro plano** (*when in use*). **Não** adicione
  `ACCESS_BACKGROUND_LOCATION` nem *Always* no iOS — dispara revisão extra e justificativa.
- **App tipo "webview"**: a Apple (diretriz 4.2) às vezes questiona apps que são só um site
  embrulhado. O VAP tem função nativa real (câmera, GPS, push, vibração), o que ajuda; se
  pedirem, explique o uso nativo. Se necessário, dá para migrar para assets embarcados +
  URLs de API absolutas.
- **Backend no Render (plano free) "dorme"**: o primeiro acesso após ocioso demora (cold
  start). Para uma boa avaliação na loja, considere um plano que não hiberne.
- **Guarde o keystore Android** e as credenciais Apple — perdê-los impede atualizar o app.

---

## 8. Checklist rápido

- [ ] `npm install && npx cap sync` rodados sem erro
- [ ] Ícones 512 (Play) e 1024 (App Store) gerados
- [ ] Capturas de tela tiradas
- [ ] URL da política preenchida nas duas lojas
- [ ] Questionário de dados respondido (seção 6)
- [ ] Android: `versionCode`/`versionName` atualizados, AAB assinado
- [ ] iOS: Version/Build atualizados, archive enviado
- [ ] Backend de produção acordado e respondendo antes da revisão
