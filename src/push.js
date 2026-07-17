// Web Push (VAPID) + FCM nativo (token Capacitor). Prioridade alta em ambos.
require("dotenv").config();
const webpush = require("web-push");
const { pool } = require("./db");

// Notificações push (Web Push / VAPID). Opcional: sem as chaves, o app sobe
// normalmente e só não envia notificações (mesma filosofia do Supabase).
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const pushConfigurado = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushConfigurado) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:contato@vap.app", VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn("AVISO: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY não definidos — notificações Web Push desativadas.");
}

// FCM HTTP legacy (opcional). Sem FCM_SERVER_KEY, tokens nativos são gravados
// mas o envio nativo fica inativo até configurar o Firebase no Render.
const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY || "";
const fcmConfigurado = Boolean(FCM_SERVER_KEY);

async function enviarFcm(token, payload) {
  if (!fcmConfigurado || !token) return;
  const title = payload.title || "VAP";
  const body = payload.body || "";
  const data = {};
  // FCM data values must be strings
  Object.keys(payload).forEach((k) => {
    if (payload[k] != null && k !== "title" && k !== "body") {
      data[k] = String(payload[k]);
    }
  });
  data.title = title;
  data.body = body;

  const res = await fetch("https://fcm.googleapis.com/fcm/send", {
    method: "POST",
    headers: {
      Authorization: `key=${FCM_SERVER_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: token,
      // Alta prioridade: entrega imediata mesmo com app em 2º plano / Doze.
      priority: "high",
      content_available: true,
      notification: {
        title,
        body,
        sound: "default",
        android_channel_id: "vap_carona_high",
      },
      data,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error(`FCM ${res.status}: ${txt.slice(0, 200)}`);
    err.statusCode = res.status;
    throw err;
  }
}

// Envia uma notificação para todos os aparelhos inscritos de um usuário.
// Remove inscrições mortas (app desinstalado → 404/410). Nunca lança.
async function enviarPush(usuarioId, payload) {
  if (!usuarioId) return;
  const data = JSON.stringify(payload || {});

  // 1) Web Push (PWA / navegador) — urgency high
  if (pushConfigurado) {
    try {
      const { rows } = await pool.query(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE usuario_id = $1",
        [usuarioId]
      );
      if (!rows.length) {
        console.log(`push: usuário ${usuarioId} SEM inscrição web`);
      } else {
        let falhas = 0;
        await Promise.all(rows.map(async (s) => {
          try {
            await webpush.sendNotification(
              { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
              data,
              { urgency: "high", TTL: 120 }
            );
          } catch (err) {
            falhas++;
            console.warn(`push web: falha usuário ${usuarioId} (${err.statusCode || err.message})`);
            if (err.statusCode === 404 || err.statusCode === 410) {
              await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [s.endpoint]).catch(() => {});
            }
          }
        }));
        console.log(`push web: usuário ${usuarioId} — ${rows.length} inscrição(ões), ${falhas} falha(s)`);
      }
    } catch (err) {
      console.error("enviarPush web:", err.message);
    }
  }

  // 2) FCM nativo (Capacitor) — priority high
  try {
    const { rows } = await pool.query(
      "SELECT token, platform FROM push_device_tokens WHERE usuario_id = $1",
      [usuarioId]
    );
    if (!rows.length) {
      if (fcmConfigurado) console.log(`push fcm: usuário ${usuarioId} SEM token nativo`);
      return;
    }
    if (!fcmConfigurado) {
      console.log(`push fcm: ${rows.length} token(s) gravado(s) mas FCM_SERVER_KEY ausente`);
      return;
    }
    let falhas = 0;
    await Promise.all(rows.map(async (r) => {
      try {
        await enviarFcm(r.token, payload || {});
      } catch (err) {
        falhas++;
        console.warn(`push fcm: falha usuário ${usuarioId} (${err.statusCode || err.message})`);
        if (err.statusCode === 404 || err.statusCode === 410 || /NotRegistered|InvalidRegistration/i.test(err.message || "")) {
          await pool.query("DELETE FROM push_device_tokens WHERE token = $1", [r.token]).catch(() => {});
        }
      }
    }));
    console.log(`push fcm: usuário ${usuarioId} — ${rows.length} token(s), ${falhas} falha(s)`);
  } catch (err) {
    console.error("enviarPush fcm:", err.message);
  }
}


module.exports = {
  VAPID_PUBLIC,
  VAPID_PRIVATE,
  pushConfigurado,
  fcmConfigurado,
  enviarPush,
};
