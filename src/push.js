// Web Push (VAPID) + FCM nativo HTTP v1 (firebase-admin).
// A API legada fcm.googleapis.com/fcm/send foi desligada em 2024 — não usar.
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

// FCM HTTP v1 via service account (firebase-admin).
// Env:
//   FIREBASE_SERVICE_ACCOUNT_JSON  — JSON inteiro da service account (Render)
//   GOOGLE_APPLICATION_CREDENTIALS — caminho local para o .json
//   FIREBASE_PROJECT_ID            — opcional se não vier no JSON
// FCM_SERVER_KEY (legado) é IGNORADO — API desligada pelo Google em 2024.
let _messaging = null;
let _fcmInitTried = false;
let fcmConfigurado = false;

function initFcm() {
  if (_fcmInitTried) return fcmConfigurado;
  _fcmInitTried = true;

  if (process.env.FCM_SERVER_KEY && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn(
      "AVISO: FCM_SERVER_KEY está definida, mas a API legada foi desligada (jun/2024). " +
      "Use FIREBASE_SERVICE_ACCOUNT_JSON (service account do Firebase) para push nativo."
    );
  }

  try {
    // eslint-disable-next-line global-require
    const admin = require("firebase-admin");
    if (Array.isArray(admin.apps) && admin.apps.length > 0) {
      _messaging = admin.messaging();
      fcmConfigurado = true;
      return true;
    }

    let credential;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
    if (raw.trim()) {
      const sa = JSON.parse(raw);
      credential = admin.credential.cert(sa);
      admin.initializeApp({
        credential,
        projectId: process.env.FIREBASE_PROJECT_ID || sa.project_id,
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: process.env.FIREBASE_PROJECT_ID || undefined,
      });
    } else {
      console.warn("AVISO: Firebase service account ausente — push nativo (FCM) desativado.");
      fcmConfigurado = false;
      return false;
    }

    _messaging = admin.messaging();
    fcmConfigurado = true;
    console.log("FCM HTTP v1: firebase-admin inicializado.");
    return true;
  } catch (e) {
    console.warn("FCM init falhou:", e.message);
    fcmConfigurado = false;
    return false;
  }
}

// Inicializa no load do módulo (não quebra se faltar credencial).
initFcm();

/**
 * Envia via FCM HTTP v1 (alta prioridade Android + APNs).
 * @param {string} token
 * @param {object} payload { title, body, url?, action?, ... }
 * @param {string} [platform] android|ios
 */
async function enviarFcm(token, payload, platform) {
  if (!initFcm() || !_messaging || !token) return;

  const title = payload.title || "VAP";
  const body = payload.body || "";
  const data = {};
  Object.keys(payload || {}).forEach((k) => {
    if (payload[k] != null && k !== "title" && k !== "body") {
      data[k] = String(payload[k]);
    }
  });
  data.title = title;
  data.body = body;

  const message = {
    token,
    notification: { title, body },
    data,
    android: {
      priority: "high",
      notification: {
        channelId: "vap_carona_high",
        sound: "default",
        defaultVibrateTimings: true,
      },
    },
    apns: {
      headers: {
        "apns-priority": "10",
        "apns-push-type": "alert",
      },
      payload: {
        aps: {
          alert: { title, body },
          sound: "default",
          "interruption-level": "time-sensitive",
        },
      },
    },
  };

  // Em iOS puro às vezes só data+notification; admin lida com ambos.
  try {
    await _messaging.send(message);
  } catch (err) {
    const code = err.code || err.errorInfo?.code || "";
    const status =
      /registration-token-not-registered|invalid-registration-token|not-found/i.test(code + err.message)
        ? 404
        : err.statusCode || 500;
    const e = new Error(err.message || String(err));
    e.statusCode = status;
    e.code = code;
    throw e;
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

  // 2) FCM nativo HTTP v1 (Capacitor)
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
      console.log(
        `push fcm: ${rows.length} token(s) gravado(s) mas Firebase service account ausente ` +
        `(defina FIREBASE_SERVICE_ACCOUNT_JSON no Render)`
      );
      return;
    }
    let falhas = 0;
    await Promise.all(rows.map(async (r) => {
      try {
        await enviarFcm(r.token, payload || {}, r.platform);
      } catch (err) {
        falhas++;
        console.warn(`push fcm: falha usuário ${usuarioId} (${err.code || err.statusCode || err.message})`);
        if (
          err.statusCode === 404 ||
          err.statusCode === 410 ||
          /registration-token-not-registered|invalid-registration-token|NotRegistered|InvalidRegistration/i.test(
            String(err.code || "") + String(err.message || "")
          )
        ) {
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
  get fcmConfigurado() {
    return fcmConfigurado;
  },
  enviarPush,
  initFcm,
};
