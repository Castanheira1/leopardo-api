// Web Push (VAPID): configuração e envio de notificações.
require("dotenv").config();
const webpush = require("web-push");
const app = require("./app");
const { pool } = require("./db");

// Notificações push (Web Push / VAPID). Opcional: sem as chaves, o app sobe
// normalmente e só não envia notificações (mesma filosofia do Supabase).
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const pushConfigurado = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushConfigurado) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:contato@vap.app", VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn("AVISO: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY não definidos — notificações push desativadas.");
}

// Envia uma notificação para todos os aparelhos inscritos de um usuário.
// Remove inscrições mortas (app desinstalado → 404/410). Nunca lança.
async function enviarPush(usuarioId, payload) {
  if (!pushConfigurado || !usuarioId) return;
  try {
    const { rows } = await pool.query(
      "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE usuario_id = $1",
      [usuarioId]
    );
    if (!rows.length) { console.log(`push: usuário ${usuarioId} SEM inscrição — notificação não sai`); return; }
    const data = JSON.stringify(payload);
    let falhas = 0;
    await Promise.all(rows.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data);
      } catch (err) {
        falhas++;
        console.warn(`push: falha para usuário ${usuarioId} (${err.statusCode || err.message})`);
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [s.endpoint]).catch(() => {});
        }
      }
    }));
    console.log(`push: usuário ${usuarioId} — ${rows.length} inscrição(ões), ${falhas} falha(s)`);
  } catch (err) {
    console.error("enviarPush:", err.message);
  }
}


module.exports = {
  VAPID_PUBLIC,
  VAPID_PRIVATE,
  pushConfigurado,
  enviarPush,
};
