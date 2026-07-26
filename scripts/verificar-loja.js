#!/usr/bin/env node
/**
 * Verifica o que falta para publicar na Play Store e App Store.
 * Uso: npm run store:check
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const ok = (msg) => console.log(`  ✅ ${msg}`);
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const fail = (msg) => console.log(`  ❌ ${msg}`);

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

let issues = 0;

console.log("\n=== VAP — verificação para lojas ===\n");
console.log(`App ID: com.vap.carona`);
console.log(`API:    https://leopardo-api.onrender.com\n`);

console.log("1. Projeto Capacitor");
if (exists("capacitor.config.ts") && exists("android") && exists("ios")) {
  ok("android/ e ios/ presentes");
} else {
  fail("pastas nativas ausentes — rode: npm run cap:prepare");
  issues++;
}

console.log("\n2. Ícones e splash");
if (exists("assets/icon-only.png") && exists("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png")) {
  ok("ícones Android gerados");
} else {
  warn("regenere com: npx capacitor-assets generate");
}
if (exists("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")) {
  ok("ícone iOS presente");
} else {
  warn("ícone iOS ausente");
}

console.log("\n3. Jurídico (URLs nas lojas)");
for (const f of ["public/politica-privacidade.html", "public/termos-de-uso.html", "public/excluir-conta.html"]) {
  if (exists(f)) ok(path.basename(f));
  else { fail(f + " ausente"); issues++; }
}
const polHtml = read("public/politica-privacidade.html");
if (/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(polHtml) || /CPF:/i.test(polHtml)) {
  fail("politica-privacidade.html ainda expõe CPF — use CNPJ da empresa");
  issues++;
} else {
  ok("política sem CPF público");
}
if (/\[RAZÃO SOCIAL|\[00\.000\.000\/0001-00\]|\[DOMINIO\]/.test(polHtml)) {
  warn("política ainda tem placeholders [CNPJ/razão/domínio] — preencha antes de cobrar");
} else {
  ok("política com dados do controlador preenchidos");
}

console.log("\n4. Firebase / Push");
const gsAndroid = exists("android/app/google-services.json");
const gsIos = exists("ios/App/App/GoogleService-Info.plist");
if (gsAndroid) ok("android/app/google-services.json");
else {
  warn("android/app/google-services.json — baixe no Firebase Console (push Android)");
  issues++;
}
if (gsIos) ok("ios/App/App/GoogleService-Info.plist");
else {
  warn("GoogleService-Info.plist no Xcode — baixe no Firebase (app iOS com.vap.carona)");
  issues++;
}
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  ok("FIREBASE_SERVICE_ACCOUNT_JSON definido no ambiente");
} else {
  warn("FIREBASE_SERVICE_ACCOUNT_JSON no Render — JSON da service account Firebase");
}

console.log("\n5. Deep links (domínio ↔ app)");
const assetlinks = read("public/.well-known/assetlinks.json");
if (assetlinks.includes("PREENCHER_APOS_GERAR_O_KEYSTORE")) {
  warn("assetlinks.json — cole o SHA-256 do keystore (npm run store:sha256)");
  issues++;
} else {
  ok("assetlinks.json com SHA-256");
}
const aasa = read("public/.well-known/apple-app-site-association");
if (aasa.includes("PREENCHER_TEAM_ID")) {
  warn("apple-app-site-association — troque PREENCHER_TEAM_ID pelo Team ID Apple");
  issues++;
} else {
  ok("apple-app-site-association com Team ID");
}

console.log("\n6. Assinatura Android");
const hasKeystoreEnv = process.env.ANDROID_KEYSTORE_PATH && exists(process.env.ANDROID_KEYSTORE_PATH);
if (hasKeystoreEnv || exists("vap-release.jks")) {
  ok("keystore encontrado");
} else {
  warn("keystore ausente — gere com o comando em docs/LOJA-SEU-PASSO-A-PASSO.md");
  issues++;
}

console.log("\n7. Coerência de localização (motivo comum de rejeição)");
// Os comentários explicam por que certas chaves NÃO estão declaradas e citam os
// próprios nomes — sem removê-los, a checagem acusaria falso positivo.
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, "");
const manifest = semComentarios(read("android/app/src/main/AndroidManifest.xml"));
if (manifest.includes("ACCESS_BACKGROUND_LOCATION")) {
  fail("ACCESS_BACKGROUND_LOCATION voltou ao manifest — exige a declaração de");
  fail("  background location no Play Console (formulário + vídeo). Veja PUBLICAR-LOJAS.md §7");
  issues++;
} else {
  ok("Android sem ACCESS_BACKGROUND_LOCATION (Foreground Service cobre a viagem)");
}
if (manifest.includes('android:foregroundServiceType="location"')) {
  ok("TripTrackingService declarado como foreground service de localização");
} else {
  fail("foregroundServiceType=location ausente — rastreio da viagem para em background");
  issues++;
}

// A Apple rejeita (2.5.4) quem declara o modo de fundo sem implementá-lo. O modo
// só é legítimo enquanto existir o plugin nativo ligando allowsBackgroundLocationUpdates.
const infoPlist = semComentarios(read("ios/App/App/Info.plist"));
const bgModes = infoPlist.match(/<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/);
const declaraLocation = !!(bgModes && bgModes[1].includes("<string>location</string>"));
const pluginIos = exists("ios/App/App/TripTrackingPlugin.swift")
  && read("ios/App/App/TripTrackingPlugin.swift").includes("allowsBackgroundLocationUpdates");
const noTargetIos = read("ios/App/App.xcodeproj/project.pbxproj")
  .includes("TripTrackingPlugin.swift in Sources");

// O Capacitor só auto-registra plugins vindos de npm (packageClassList do
// capacitor.config.json). O plugin local depende do registro manual na
// MainViewController — se isso quebrar, o rastreio some sem erro nenhum.
const registrado =
  exists("ios/App/App/MainViewController.swift")
  && read("ios/App/App/MainViewController.swift").includes("registerPluginInstance(TripTrackingPlugin())")
  && read("ios/App/App/Base.lproj/Main.storyboard").includes('customClass="MainViewController"');

if (declaraLocation && pluginIos && noTargetIos && registrado) {
  ok("iOS: background location declarado, implementado e plugin registrado");
} else if (declaraLocation && pluginIos && noTargetIos) {
  fail("TripTrackingPlugin.swift existe mas não é registrado — Capacitor.Plugins.");
  fail("  TripTracking fica indefinido e o rastreio para sem erro. Confira");
  fail("  MainViewController.swift e o customClass no Main.storyboard");
  issues++;
} else if (declaraLocation) {
  fail("iOS declara UIBackgroundModes=location sem implementação nativa completa");
  if (!pluginIos) fail("  falta TripTrackingPlugin.swift com allowsBackgroundLocationUpdates");
  if (!noTargetIos) fail("  TripTrackingPlugin.swift fora do target App no project.pbxproj");
  fail("  Rejeição 2.5.4 da App Store. Veja PUBLICAR-LOJAS.md §7");
  issues++;
} else if (pluginIos) {
  fail("TripTrackingPlugin.swift existe mas falta 'location' em UIBackgroundModes —");
  fail("  sem o modo, o iOS suspende o app e o rastreio para na tela apagada");
  issues++;
} else {
  ok("iOS sem background location (declaração e implementação coerentes)");
}
if (/NSLocationAlways(AndWhenInUse)?UsageDescription/.test(infoPlist)) {
  warn("Info.plist pede 'Always', mas 'When In Use' + modo de fundo já bastam —");
  warn("  'Always' é atrito extra e mais escrutínio na revisão. Considere remover.");
}

const privacy = semComentarios(read("ios/App/App/PrivacyInfo.xcprivacy"));
if (/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\s*\/>/.test(privacy)) {
  fail("PrivacyInfo.xcprivacy declara zero dados coletados, mas o app coleta");
  fail("  localização, fotos e contato — precisa bater com o App Store Connect");
  issues++;
} else {
  ok("PrivacyInfo.xcprivacy com dados coletados declarados");
}

console.log("\n8. Versão do app (lojas)");
const gradle = read("android/app/build.gradle");
const vc = gradle.match(/versionCode\s+(\d+)/);
const vn = gradle.match(/versionName\s+"([^"]+)"/);
console.log(`  Android: versionCode ${vc?.[1] || "?"}, versionName "${vn?.[1] || "?"}"`);
console.log("  iOS: confira Version/Build no Xcode antes de cada envio");

console.log("\n---");
if (issues === 0) {
  console.log("Tudo crítico no repositório parece OK. Falta: contas, builds assinados e ficha nas lojas.\n");
} else {
  console.log(`${issues} item(ns) pendente(s). Veja docs/LOJA-SEU-PASSO-A-PASSO.md\n`);
}
