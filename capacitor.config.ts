import type { CapacitorConfig } from "@capacitor/cli";

// O app nativo carrega o backend publicado. Como o front usa caminhos relativos
// (/api/...), o modo que funciona é apontar server.url para o backend em produção.
// Sobrescreva com a variável se mudar de host:
//   CAPACITOR_SERVER_URL=https://outro-host npx cap sync
// (ver docs/PUBLICAR-LOJAS.md e docs/CAPACITOR.md).
const PROD_URL = "https://leopardo-api.onrender.com";
const serverUrl = process.env.CAPACITOR_SERVER_URL || PROD_URL;

const config: CapacitorConfig = {
  appId: "com.vap.carona",
  appName: "VAP",
  webDir: "public",
  server: { url: serverUrl, cleartext: false },
};

export default config;
