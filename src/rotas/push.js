// Inscrição/remoção de push do aparelho (Web Push + token FCM nativo).
require("dotenv").config();
const app = require("../app");
const { pool } = require("../db");
const { verificarAuth } = require("../auth");

/* ============================ PUSH ============================ */
// Registra o aparelho do usuário para receber notificações (Web Push / PWA).
app.post("/api/push/subscribe", verificarAuth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: "Inscrição inválida" });
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (usuario_id, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint)
       DO UPDATE SET usuario_id = EXCLUDED.usuario_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user.id, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("push subscribe:", err.message);
    res.status(500).json({ error: "Erro ao registrar notificações" });
  }
});

// Remove a inscrição (logout / usuário desligou as notificações).
app.post("/api/push/unsubscribe", verificarAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint obrigatório" });
  try {
    await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND usuario_id = $2", [endpoint, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao remover notificações" });
  }
});

// Token nativo (Capacitor Push Notifications → FCM/APNs).
app.post("/api/push/device-token", verificarAuth, async (req, res) => {
  const token = String(req.body?.token || "").trim();
  const platform = String(req.body?.platform || "android").toLowerCase().slice(0, 20);
  if (!token || token.length < 20) return res.status(400).json({ error: "Token inválido" });
  try {
    await pool.query(
      `INSERT INTO push_device_tokens (usuario_id, token, platform, atualizado_em)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (token)
       DO UPDATE SET usuario_id = EXCLUDED.usuario_id, platform = EXCLUDED.platform, atualizado_em = NOW()`,
      [req.user.id, token, platform === "ios" ? "ios" : "android"]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("push device-token:", err.message);
    res.status(500).json({ error: "Erro ao registrar token nativo" });
  }
});

app.post("/api/push/device-token/remove", verificarAuth, async (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "token obrigatório" });
  try {
    await pool.query(
      "DELETE FROM push_device_tokens WHERE token = $1 AND usuario_id = $2",
      [token, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao remover token" });
  }
});

