// Socket.io: canal em tempo real para coordenadas da viagem (clientes nativos).
// PWA continua em HTTP polling — este módulo só atende quem se conecta via WS.
require("dotenv").config();
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("./config");
const { pool } = require("./db");

let io = null;

function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload && payload.id ? payload : null;
  } catch {
    return null;
  }
}

async function sessaoValida(payload) {
  try {
    const { rows } = await pool.query(
      "SELECT sessao_id FROM usuarios WHERE id = $1 AND COALESCE(ativo, TRUE) = TRUE",
      [payload.id]
    );
    if (!rows.length) return false;
    if (!payload.sid || !rows[0].sessao_id || payload.sid !== rows[0].sessao_id) return false;
    return true;
  } catch {
    return false;
  }
}

async function podeAcessarViagem(userId, viagemId) {
  const { rows } = await pool.query(
    "SELECT motorista_id, passageiro_id, status, fase FROM viagens WHERE id = $1",
    [viagemId]
  );
  const v = rows[0];
  if (!v) return null;
  if (v.motorista_id !== userId && v.passageiro_id !== userId) return null;
  return v;
}

async function upsertLocalizacao(userId, lat, lng, disponivel) {
  await pool.query(
    `INSERT INTO localizacoes_online (usuario_id, lat, lng, disponivel, atualizado_em)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (usuario_id)
     DO UPDATE SET lat = $2, lng = $3, disponivel = $4, atualizado_em = NOW()`,
    [userId, lat, lng, disponivel !== false]
  );
}

/**
 * Anexa Socket.io ao http.Server do Express.
 * @param {import('http').Server} httpServer
 */
function attachRealtime(httpServer) {
  const CORS_ORIGINS = (process.env.CORS_ORIGINS || process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  io = new Server(httpServer, {
    path: "/socket.io",
    cors: {
      origin: CORS_ORIGINS.length ? CORS_ORIGINS : true,
      credentials: true,
    },
    // reconexão é responsabilidade do client; server aceita de novo
    pingInterval: 20000,
    pingTimeout: 20000,
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    const payload = userFromToken(token);
    if (!payload) return next(new Error("unauthorized"));
    if (!(await sessaoValida(payload))) return next(new Error("unauthorized"));
    socket.user = payload;
    next();
  });

  io.on("connection", (socket) => {
    const uid = socket.user.id;

    socket.on("join_viagem", async (msg, ack) => {
      try {
        const viagemId = Number(msg?.viagemId);
        if (!viagemId) {
          if (typeof ack === "function") ack({ ok: false, error: "viagemId inválido" });
          return;
        }
        const v = await podeAcessarViagem(uid, viagemId);
        if (!v) {
          if (typeof ack === "function") ack({ ok: false, error: "sem permissão" });
          return;
        }
        const room = `viagem:${viagemId}`;
        await socket.join(room);
        socket.data.viagemId = viagemId;
        if (typeof ack === "function") ack({ ok: true, status: v.status, fase: v.fase });
      } catch (e) {
        console.warn("join_viagem:", e.message);
        if (typeof ack === "function") ack({ ok: false, error: "erro" });
      }
    });

    socket.on("leave_viagem", async (msg) => {
      const viagemId = Number(msg?.viagemId || socket.data.viagemId);
      if (!viagemId) return;
      await socket.leave(`viagem:${viagemId}`);
      if (socket.data.viagemId === viagemId) socket.data.viagemId = null;
    });

    socket.on("loc_update", async (msg) => {
      try {
        const viagemId = Number(msg?.viagemId || socket.data.viagemId);
        const lat = Number(msg?.lat);
        const lng = Number(msg?.lng);
        if (!viagemId || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

        const v = await podeAcessarViagem(uid, viagemId);
        if (!v || v.status !== "em_andamento") return;

        await upsertLocalizacao(uid, lat, lng, msg?.disponivel !== false);

        // Espelha para o outro participante da viagem (não ecoa pro próprio socket).
        socket.to(`viagem:${viagemId}`).emit("viagem_loc", {
          viagemId,
          usuarioId: uid,
          lat,
          lng,
          papel: uid === v.motorista_id ? "motorista" : "passageiro",
          fase: v.fase,
          status: v.status,
          em: Date.now(),
        });
      } catch (e) {
        console.warn("loc_update:", e.message);
      }
    });

    socket.on("disconnect", () => {
      /* room membership limpa sozinho */
    });
  });

  console.log("Socket.io: canal realtime de viagens ativo");
  return io;
}

/** Notifica a sala da viagem sobre mudança de fase/status (opcional, para nativos). */
function emitViagemMeta(viagemId, meta) {
  if (!io) return;
  io.to(`viagem:${viagemId}`).emit("viagem_meta", {
    viagemId: Number(viagemId),
    ...meta,
    em: Date.now(),
  });
}

function getIo() {
  return io;
}

module.exports = {
  attachRealtime,
  emitViagemMeta,
  getIo,
};
