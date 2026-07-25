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
- **Permissões** declaradas: câmera, GPS, push
- **Rastreio da viagem em segundo plano nas duas plataformas** — Foreground Service no
  Android, plugin nativo `TripTrackingPlugin.swift` no iOS. No Android isso **não**
  exige a permissão de localização em segundo plano, então no Play Console responda
  **"Não"** a essa pergunta. Na Apple, o `store/listagem-lojas.md` já traz o texto de
  justificativa para as notas de revisão (detalhes na seção 7 de `docs/PUBLICAR-LOJAS.md`)
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

### Fase 1 — Contas (pessoa física)

> ## ⚠️ Leia isto antes de abrir a conta do Google
>
> Contas **pessoais** do Google Play criadas depois de nov/2023 só podem publicar em
> produção depois de rodar um **teste fechado com no mínimo 12 testadores inscritos
> continuamente por 14 dias**. Contas de organização (CNPJ + D-U-N-S) são dispensadas.
>
> **Consequência prática:** o relógio de 14 dias é o item mais longo de todo o
> processo. Ele não depende de mais nada — nem de Firebase, nem de iOS, nem de
> screenshots. **Comece por ele.** Suba um build no teste fechado assim que a conta
> sair, junte os 12 colegas, e deixe os 14 dias correrem enquanto você faz o resto.
> Fazer na ordem errada custa duas semanas paradas no fim.

**Conta Google Play** — US$ 25, pagamento único, https://play.google.com/console

Tenha em mãos:
- Conta Google (a que você usa hoje serve)
- Cartão de crédito internacional
- **Documento oficial com foto** (RG ou CNH) — a verificação de identidade é obrigatória
- Nome e endereço **exatamente como no documento**
- Telefone para verificação

Ao cadastrar, escolha o tipo **"Pessoal"**. Atenção: o nome do desenvolvedor e um
e-mail de contato ficam **visíveis publicamente** na ficha do app. Se não quiser expor
o e-mail pessoal, crie um específico para isso (ex.: `suporte.vap@…`) antes de começar.

**Conta Apple Developer** — US$ 99/ano, https://developer.apple.com/programs/enroll

Tenha em mãos:
- Apple ID com **autenticação de dois fatores já ativada** (sem isso o enrollment trava)
- Cartão de crédito internacional
- Nome legal igual ao do documento — no enrollment **individual**, esse nome aparece
  publicamente como vendedor do app na App Store

**Mac:** não é mais bloqueio. O CI deste repositório compila o app iOS em runner
macOS (job `ios` no `.github/workflows/ci.yml`). Para assinar e enviar à App Store
ainda falta montar a esteira com certificado e App Store Connect API key — dá para
fazer no próprio CI, sem Mac físico.

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
| 15 | **Teste fechado com 12 testadores** | Play Console → Testes → Teste fechado. **Faça isto primeiro** — são 14 dias corridos (veja o aviso na Fase 1) |
| 16 | **Segurança dos dados** | Marcar localização, fotos, contato (ver `docs/PUBLICAR-LOJAS.md` §6) |
| 17 | **Localização em segundo plano** | Responda **"Não"**. O app usa Foreground Service, não `ACCESS_BACKGROUND_LOCATION` — sem formulário nem vídeo |

---

### Fase 4 — iOS

O código Swift já é compilado pelo CI a cada mudança em `ios/` (job `ios`, runner
macOS). O que falta é assinar e enviar — dá para fazer no CI, sem Mac físico.

| # | Tarefa | Ação |
|---|--------|------|
| 18 | Team ID no AASA | Trocar `PREENCHER_TEAM_ID` em `public/.well-known/apple-app-site-association` e fazer deploy |
| 19 | Criar app no **App Store Connect** | Bundle `com.vap.carona` |
| 20 | **Certificado de distribuição** | CSR com `openssl` → portal Apple → `.cer` → `.p12`. Não exige Mac |
| 21 | **App Store Connect API key** (`.p8`) | Users and Access → Integrations → App Store Connect API |
| 22 | Esteira de envio no CI | `xcodebuild archive` + `-exportArchive` + upload. Guardar `.p12` e `.p8` como secrets |
| 23 | **App Privacy** | Localização, fotos, contato — sem rastreamento de ads. Deve bater com `PrivacyInfo.xcprivacy` |
| 24 | Conta de **teste** para revisão | Matrícula/senha nas notas do revisor (`store/listagem-lojas.md`) |
| 25 | Justificativa do **background location** | Texto pronto em `store/listagem-lojas.md` — a Apple pergunta |

Alternativa, se preferir o caminho manual: `npm run cap:ios` abre o Xcode num Mac,
e daí é Signing & Capabilities → Product → Archive → Distribute.

---

### Fase 5 — Ficha das duas lojas

| # | Tarefa |
|---|--------|
| 26 | Tirar **screenshots** (login, mapa, pedido, viagem, perfil) |
| 27 | Copiar textos de `store/listagem-lojas.md` |
| 28 | URL da política de privacidade nas duas lojas |
| 29 | Backend no **starter Render (US$ 7)** já fica acordado — opcional: monitor em `/api/health` |

Os tamanhos de screenshot exigidos estão em `store/listagem-lojas.md`. Na Apple eles
podem ser gerados no simulador (`xcrun simctl`), inclusive pelo runner macOS do CI —
não precisa de iPhone físico só para isso.

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

O caminho crítico é o teste fechado do Google: 14 dias que correm em paralelo com
todo o resto. Começar por ele é o que define se a publicação leva 2 ou 5 semanas.

```
[VOCÊ] Conta Google Play (US$ 25)
   ↓
[VOCÊ] Keystore + SHA-256 no assetlinks + deploy backend
   ↓
[VOCÊ] AAB assinado → TESTE FECHADO com 12 testadores
   ↓
        ├── 14 dias correndo ───────────────────────┐
        │                                            │
        │  em paralelo, sem esperar:                 │
        │   [VOCÊ] Conta Apple (US$ 99)              │
        │   [VOCÊ] Firebase + APNs key               │
        │   [VOCÊ] Screenshots das duas lojas        │
        │   [VOCÊ] Questionários de privacidade      │
        │   [VOCÊ] Team ID no AASA + deploy          │
        │   [NÓS]  Esteira de assinatura iOS no CI   │
        │                                            ↓
        └──────────────────────────→ Solicitar produção na Play
                                     Enviar para revisão na Apple
```

O código do app, permissões, ícones, jurídico e estrutura nativa **já estão prontos**. O que bloqueia a publicação são credenciais, builds assinados e o preenchimento das fichas nas lojas.
