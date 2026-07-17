import type { CapacitorConfig } from "@capacitor/cli";

// Bundle local (webDir) por padrão — exigência de loja / Apple 4.2 (não é só web-frame).
// O JS detecta nativo e chama a API em https://leopardo-api.onrender.com (platform.js).
//
// Live reload / apontar o WebView no site remoto (dev):
//   CAPACITOR_SERVER_URL=https://leopardo-api.onrender.com npx cap sync
const liveUrl = process.env.CAPACITOR_SERVER_URL || "";

const config: CapacitorConfig = {
  appId: "com.vap.carona",
  appName: "VAP",
  webDir: "public",
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

// Só ativa server.url se a variável for definida (dev / hotfix remoto).
if (liveUrl) {
  config.server = { url: liveUrl, cleartext: false };
}

export default config;
