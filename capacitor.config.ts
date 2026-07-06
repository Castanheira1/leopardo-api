import type { CapacitorConfig } from "@capacitor/cli";

// Build apontando para o backend publicado (ex.: https://vagao.onrender.com):
//   CAPACITOR_SERVER_URL=https://vagao.onrender.com npx cap sync
// Sem a variável, o app embarca os arquivos de public/ como assets locais
// (útil para inspecionar o shell nativo, mas as chamadas a /api/... exigem
// um backend acessível — ver docs/CAPACITOR.md).
const serverUrl = process.env.CAPACITOR_SERVER_URL;

const config: CapacitorConfig = {
  appId: "com.vap.carona",
  appName: "VAP",
  webDir: "public",
  server: serverUrl
    ? { url: serverUrl, cleartext: false }
    : { androidScheme: "https" },
};

export default config;
