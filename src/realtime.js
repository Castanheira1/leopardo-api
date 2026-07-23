// Socket.io: canal em tempo real para coordenadas da viagem (PWA + nativo).
// HTTP polling continua como fallback se o WS cair.
require("dotenv").config();
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("./config");
const { pool } = require("./db");
const { allAllowedOrigins } = require("./cors-origins");

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

function normalizarSpeedKmh(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  // GPS ruidoso: ignora picos absurdos; 0 = parado (válido).
  if (n > 160) return null;
  return Math.round(n * 10) / 10;
}

async function upsertLocalizacao(userId, lat, lng, disponivel, speedKmh) {
  const vel = normalizarSpeedKmh(speedKmh);
  await pool.query(
    `INSERT INTO localizacoes_online (usuario_id, lat, lng, disponivel, speed_kmh, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (usuario_id)
     DO UPDATE SET lat = $2, lng = $3, disponivel = $4,
                   speed_kmh = COALESCE($5, localizacoes_online.speed_kmh),
                   atualizado_em = NOW()`,
    [userId, lat, lng, disponivel !== false, vel]
  );
}

function cacheViagemNoSocket(socket, viagemId, v) {
  socket.data.viagemId = viagemId;
  socket.data.viagemPeers = {
    motorista_id: v.motorista_id,
    passageiro_id: v.passageiro_id,
    status: v.status,
    fase: v.fase,
  };
  socket.data.viagemPeersAt = Date.now();
}

/**
 * Anexa Socket.io ao http.Server do Express.
 * @param {import('http').Server} httpServer
 */
function attachRealtime(httpServer) {
  const origins = allAllowedOrigins();

  io = new Server(httpServer, {
    path: "/socket.io",
    cors: {
      origin: origins.length ? origins : true,
      credentials: true,
    },
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
        await socket.join(`viagem:${viagemId}`);
        cacheViagemNoSocket(socket, viagemId, v);
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
      if (socket.data.viagemId === viagemId) {
        socket.data.viagemId = null;
        socket.data.viagemPeers = null;
      }
    });

    socket.on("loc_update", async (msg) => {
      try {
        const viagemId = Number(msg?.viagemId || socket.data.viagemId);
        const lat = Number(msg?.lat);
        const lng = Number(msg?.lng);
        if (!viagemId || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
        const speedKmh = normalizarSpeedKmh(msg?.speed_kmh ?? msg?.speedKmh);

        // Cache da permissão (~12s): evita SELECT a cada ponto GPS (~1,5s).
        const agora = Date.now();
        let peers = socket.data.viagemPeers;
        const cacheOk = peers
          && Number(socket.data.viagemId) === viagemId
          && agora - (socket.data.viagemPeersAt || 0) < 12000;

        if (!cacheOk) {
          const v = await podeAcessarViagem(uid, viagemId);
          if (!v || v.status !== "em_andamento") return;
          cacheViagemNoSocket(socket, viagemId, v);
          peers = socket.data.viagemPeers;
        } else if (peers.status !== "em_andamento") {
          return;
        }

        await upsertLocalizacao(uid, lat, lng, msg?.disponivel !== false, speedKmh);

        const payload = {
          viagemId,
          usuarioId: uid,
          lat,
          lng,
          papel: uid === peers.motorista_id ? "motorista" : "passageiro",
          fase: peers.fase,
          status: peers.status,
          em: Date.now(),
        };
        if (speedKmh != null) payload.speed_kmh = speedKmh;
        socket.to(`viagem:${viagemId}`).emit("viagem_loc", payload);
      } catch (e) {
        console.warn("loc_update:", e.message);
      }
    });

    socket.on("disconnect", () => {
      /* room membership limpa sozinho */
    });
  });

  console.log("Socket.io: canal realtime de viagens ativo (PWA + nativo)");
  return io;
}

/** Notifica a sala da viagem sobre mudança de fase/status. */
function emitViagemMeta(viagemId, meta) {
  if (!io) return;
  const room = `viagem:${viagemId}`;
  // Atualiza cache de fase/status nos sockets da sala (próximos loc_update).
  try {
    const sockets = io.sockets.adapter.rooms.get(room);
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s?.data?.viagemPeers && Number(s.data.viagemId) === Number(viagemId)) {
          if (meta.status != null) s.data.viagemPeers.status = meta.status;
          if (meta.fase != null) s.data.viagemPeers.fase = meta.fase;
          s.data.viagemPeersAt = Date.now();
        }
      }
    }
  } catch (_) { /* best-effort */ }
  io.to(room).emit("viagem_meta", {
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
