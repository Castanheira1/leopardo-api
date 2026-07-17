// Isolamento de plataforma (PWA vs Capacitor nativo).
// PWA: tudo via browser (localStorage, Web Push, HTTP poll).
// Nativo: Preferences, Push Notifications, Geolocation FG, Socket.io.
// Não quebra a web — só ativa extras quando Capacitor.isNativePlatform().
(function (global) {
  "use strict";

  function cap() {
    return global.Capacitor || null;
  }

  function isNative() {
    try {
      const C = cap();
      if (!C) return false;
      if (typeof C.isNativePlatform === "function") return !!C.isNativePlatform();
      return C.getPlatform && C.getPlatform() !== "web";
    } catch (_) {
      return false;
    }
  }

  function plugin(name) {
    const C = cap();
    if (!C || !C.Plugins) return null;
    return C.Plugins[name] || null;
  }

  // ---------- Preferences (nativo) com fallback localStorage (PWA) ----------
  async function prefGet(key) {
    try {
      const P = plugin("Preferences");
      if (P && typeof P.get === "function") {
        const r = await P.get({ key });
        return r && r.value != null ? r.value : null;
      }
    } catch (_) { /* fallback */ }
    try {
      return global.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  async function prefSet(key, value) {
    const str = value == null ? "" : String(value);
    try {
      const P = plugin("Preferences");
      if (P && typeof P.set === "function") {
        await P.set({ key, value: str });
        return;
      }
    } catch (_) { /* fallback */ }
    try {
      global.localStorage.setItem(key, str);
    } catch (_) {}
  }

  async function prefRemove(key) {
    try {
      const P = plugin("Preferences");
      if (P && typeof P.remove === "function") {
        await P.remove({ key });
        return;
      }
    } catch (_) { /* fallback */ }
    try {
      global.localStorage.removeItem(key);
    } catch (_) {}
  }

  // Buffer de pontos da rota (persistente — sobrevive a perda de rede/túnel).
  const RouteBuffer = {
    _key(viagemId) {
      return "vap_route_buf_" + String(viagemId);
    },
    async load(viagemId) {
      try {
        const raw = await prefGet(this._key(viagemId));
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch (_) {
        return [];
      }
    },
    async save(viagemId, pontos) {
      const list = Array.isArray(pontos) ? pontos.slice(-2000) : [];
      await prefSet(this._key(viagemId), JSON.stringify(list));
    },
    async append(viagemId, ponto) {
      const list = await this.load(viagemId);
      list.push(ponto);
      await this.save(viagemId, list);
      return list;
    },
    async appendMany(viagemId, pontos) {
      if (!pontos || !pontos.length) return this.load(viagemId);
      const list = await this.load(viagemId);
      for (const p of pontos) list.push(p);
      await this.save(viagemId, list);
      return list;
    },
    /** Lê e limpa o buffer. Se o envio falhar, chame restore(). */
    async takeAll(viagemId) {
      const list = await this.load(viagemId);
      await prefRemove(this._key(viagemId));
      return list;
    },
    async restore(viagemId, pontos) {
      if (!pontos || !pontos.length) return;
      const atuais = await this.load(viagemId);
      await this.save(viagemId, pontos.concat(atuais));
    },
    async clear(viagemId) {
      await prefRemove(this._key(viagemId));
    },
  };

  // ---------- Foreground Service (Android nativo, viagem ativa) ----------
  async function startTripTracking(opts) {
    if (!isNative()) return false;
    try {
      const T = plugin("TripTracking");
      if (T && typeof T.start === "function") {
        await T.start({
          title: (opts && opts.title) || "VAP",
          body: (opts && opts.body) || "Rastreando sua viagem",
        });
        return true;
      }
    } catch (e) {
      console.warn("TripTracking.start:", e && e.message);
    }
    return false;
  }

  async function stopTripTracking() {
    if (!isNative()) return false;
    try {
      const T = plugin("TripTracking");
      if (T && typeof T.stop === "function") {
        await T.stop();
        return true;
      }
    } catch (e) {
      console.warn("TripTracking.stop:", e && e.message);
    }
    return false;
  }

  // ---------- Geolocation nativa (opcional; fallback navigator) ----------
  async function watchPositionNative(onOk, onErr, options) {
    const G = plugin("Geolocation");
    if (!G || typeof G.watchPosition !== "function") return null;
    try {
      const id = await G.watchPosition(options || { enableHighAccuracy: true, timeout: 12000 }, (pos, err) => {
        if (err) {
          if (onErr) onErr(err);
          return;
        }
        if (pos && pos.coords && onOk) {
          onOk({
            coords: {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            },
          });
        }
      });
      return id;
    } catch (e) {
      if (onErr) onErr(e);
      return null;
    }
  }

  async function clearWatchNative(id) {
    const G = plugin("Geolocation");
    if (!G || id == null) return;
    try {
      await G.clearWatch({ id });
    } catch (_) {}
  }

  global.VapPlatform = {
    isNative,
    plugin,
    prefGet,
    prefSet,
    prefRemove,
    RouteBuffer,
    startTripTracking,
    stopTripTracking,
    watchPositionNative,
    clearWatchNative,
  };
})(typeof window !== "undefined" ? window : globalThis);
