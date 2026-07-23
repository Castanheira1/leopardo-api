// Origens permitidas no CORS (Express + Socket.io).
// PWA: mesma origem da API — não precisa de CORS.
// App Capacitor (bundle local): WebView usa capacitor:// ou localhost → precisa liberar.
require("dotenv").config();

const CAPACITOR_ORIGINS = [
  "capacitor://localhost",
  "ionic://localhost",
  "http://localhost",
  "https://localhost",
  "http://127.0.0.1",
  "https://127.0.0.1",
];

function parseEnvOrigins() {
  return (process.env.CORS_ORIGINS || process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function allAllowedOrigins() {
  return [...new Set([...parseEnvOrigins(), ...CAPACITOR_ORIGINS])];
}

function originPermitida(origin) {
  if (!origin) return true;
  if (allAllowedOrigins().includes(origin)) return true;
  if (/^https?:\/\/localhost(:\d+)?$/i.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) return true;
  return false;
}

/** Callback para o pacote `cors` do Express. */
function corsOriginCallback(origin, callback) {
  callback(null, originPermitida(origin));
}

module.exports = {
  CAPACITOR_ORIGINS,
  parseEnvOrigins,
  allAllowedOrigins,
  originPermitida,
  corsOriginCallback,
};
