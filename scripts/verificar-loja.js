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

console.log("\n7. Versão do app (lojas)");
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
