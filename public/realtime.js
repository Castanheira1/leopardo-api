// Transporte em tempo real da viagem.
// - Nativo (Capacitor): Socket.io com reconexão exponencial.
// - PWA/Web: não conecta — o dashboard mantém o HTTP polling atual.
(function (global) {
  "use strict";

  var socket = null;
  var joinedViagemId = null;
  var onPeerLoc = null;
  var onMeta = null;
  var connectPromise = null;

  function isNative() {
    return global.VapPlatform && global.VapPlatform.isNative && global.VapPlatform.isNative();
  }

  function token() {
    try {
      return global.localStorage.getItem("token") || "";
    } catch (_) {
      return "";
    }
  }

  function socketBase() {
    // Mesma regra do apiBase: bundle local → host de produção; PWA/remoto → origin.
    if (global.VapPlatform && typeof global.VapPlatform.apiBase === "function") {
      var b = global.VapPlatform.apiBase();
      if (b) return b;
    }
    return global.location && global.location.origin ? global.location.origin : "";
  }

  function loadSocketIo() {
    if (global.io) return Promise.resolve();
    var src = "/socket.io/socket.io.js";
    if (global.VapPlatform && typeof global.VapPlatform.apiUrl === "function") {
      src = global.VapPlatform.apiUrl(src);
    }
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Falha ao carregar socket.io")); };
      document.head.appendChild(s);
    });
  }

  async function connect() {
    if (!isNative()) return null;
    if (socket && socket.connected) return socket;
    if (connectPromise) return connectPromise;

    connectPromise = (async function () {
      await loadSocketIo();
      if (!global.io) throw new Error("socket.io indisponível");

      if (socket) {
        try { socket.disconnect(); } catch (_) {}
        socket = null;
      }

      var base = socketBase();
      socket = global.io(base || undefined, {
        path: "/socket.io",
        transports: ["websocket", "polling"],
        auth: { token: token() },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 15000,
        randomizationFactor: 0.4,
        timeout: 12000,
      });

      socket.on("connect", function () {
        if (joinedViagemId != null) {
          socket.emit("join_viagem", { viagemId: joinedViagemId });
        }
      });

      socket.on("viagem_loc", function (payload) {
        if (!payload || !onPeerLoc) return;
        if (joinedViagemId != null && Number(payload.viagemId) !== Number(joinedViagemId)) return;
        onPeerLoc(payload);
      });

      socket.on("viagem_meta", function (payload) {
        if (!payload || !onMeta) return;
        if (joinedViagemId != null && Number(payload.viagemId) !== Number(joinedViagemId)) return;
        onMeta(payload);
      });

      await new Promise(function (resolve) {
        if (socket.connected) return resolve();
        var t = setTimeout(resolve, 8000);
        socket.once("connect", function () {
          clearTimeout(t);
          resolve();
        });
        socket.once("connect_error", function () {
          clearTimeout(t);
          resolve();
        });
      });

      return socket;
    })();

    try {
      return await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  async function joinViagem(viagemId, handlers) {
    if (!isNative()) return false;
    joinedViagemId = viagemId;
    onPeerLoc = handlers && handlers.onPeerLoc ? handlers.onPeerLoc : null;
    onMeta = handlers && handlers.onMeta ? handlers.onMeta : null;
    var s = await connect();
    if (!s) return false;
    s.emit("join_viagem", { viagemId: viagemId });
    return true;
  }

  function leaveViagem() {
    if (socket && joinedViagemId != null) {
      try { socket.emit("leave_viagem", { viagemId: joinedViagemId }); } catch (_) {}
    }
    joinedViagemId = null;
    onPeerLoc = null;
    onMeta = null;
  }

  function emitLoc(viagemId, pt) {
    if (!isNative() || !socket || !socket.connected) return false;
    if (!pt || !Number.isFinite(+pt.lat) || !Number.isFinite(+pt.lng)) return false;
    socket.emit("loc_update", {
      viagemId: viagemId,
      lat: +pt.lat,
      lng: +pt.lng,
      disponivel: true,
    });
    return true;
  }

  function disconnect() {
    leaveViagem();
    if (socket) {
      try { socket.disconnect(); } catch (_) {}
      socket = null;
    }
  }

  function connected() {
    return !!(socket && socket.connected);
  }

  global.VapRealtime = {
    isNative: isNative,
    connect: connect,
    joinViagem: joinViagem,
    leaveViagem: leaveViagem,
    emitLoc: emitLoc,
    disconnect: disconnect,
    connected: connected,
  };
})(typeof window !== "undefined" ? window : globalThis);
