// Isolamento de plataforma (PWA vs Capacitor nativo).
// PWA: same-origin, localStorage, Web Push, HTTP poll.
// Nativo (bundle local): API absoluta + plugins Capacitor.
// Nativo (server.url remoto): same-origin do host — apiBase vazio.
(function (global) {
  "use strict";

  // Backend de produção (bundle local do app nativo).
  var DEFAULT_API_HOST = "https://leopardo-api.onrender.com";

  function cap() {
    return global.Capacitor || null;
  }

  function isNative() {
    try {
      var C = cap();
      if (!C) return false;
      if (typeof C.isNativePlatform === "function") return !!C.isNativePlatform();
      return C.getPlatform && C.getPlatform() !== "web";
    } catch (_) {
      return false;
    }
  }

  function plugin(name) {
    var C = cap();
    if (!C || !C.Plugins) return null;
    return C.Plugins[name] || null;
  }

  /**
   * Base da API.
   * - PWA / same-origin: "" (caminhos /api/... relativos)
   * - Capacitor com assets locais (capacitor:// ou localhost): host de produção
   * - Capacitor com server.url no Render: "" (já está no host certo)
   */
  function apiBase() {
    try {
      if (!isNative()) return "";
      var o = String((global.location && global.location.origin) || "");
      if (!o || o === "null") return DEFAULT_API_HOST;
      // Origens do WebView com bundle embutido
      if (
        o.indexOf("capacitor://") === 0 ||
        o.indexOf("ionic://") === 0 ||
        o.indexOf("http://localhost") === 0 ||
        o.indexOf("https://localhost") === 0 ||
        o.indexOf("http://127.0.0.1") === 0
      ) {
        return DEFAULT_API_HOST;
      }
      // server.url apontando para o backend: same-origin
      return "";
    } catch (_) {
      return isNative() ? DEFAULT_API_HOST : "";
    }
  }

  function apiUrl(path) {
    if (path == null || path === "") return path;
    var p = String(path);
    if (/^https?:\/\//i.test(p) || p.indexOf("//") === 0) return p;
    var base = apiBase();
    if (!base) return p;
    if (p.charAt(0) !== "/") p = "/" + p;
    return base + p;
  }

  // ---------- Preferences (nativo) com fallback localStorage (PWA) ----------
  async function prefGet(key) {
    try {
      var P = plugin("Preferences");
      if (P && typeof P.get === "function") {
        var r = await P.get({ key: key });
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
    var str = value == null ? "" : String(value);
    try {
      var P = plugin("Preferences");
      if (P && typeof P.set === "function") {
        await P.set({ key: key, value: str });
        return;
      }
    } catch (_) { /* fallback */ }
    try {
      global.localStorage.setItem(key, str);
    } catch (_) {}
  }

  async function prefRemove(key) {
    try {
      var P = plugin("Preferences");
      if (P && typeof P.remove === "function") {
        await P.remove({ key: key });
        return;
      }
    } catch (_) { /* fallback */ }
    try {
      global.localStorage.removeItem(key);
    } catch (_) {}
  }

  // Buffer de pontos da rota — snapshot único (sem duplicar memória+prefs).
  // Fluxo: load no início da viagem → pontos só na memória → persist() grava
  // o array inteiro → takeAll limpa prefs e devolve o que estava salvo (offline).
  var RouteBuffer = {
    _key: function (viagemId) {
      return "vap_route_buf_" + String(viagemId);
    },
    load: async function (viagemId) {
      try {
        var raw = await prefGet(this._key(viagemId));
        if (!raw) return [];
        var arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch (_) {
        return [];
      }
    },
    /** Substitui o snapshot persistido (não concatena — evita duplicata). */
    save: async function (viagemId, pontos) {
      var list = Array.isArray(pontos) ? pontos.slice(-2000) : [];
      if (!list.length) {
        await prefRemove(this._key(viagemId));
        return;
      }
      await prefSet(this._key(viagemId), JSON.stringify(list));
    },
    persist: async function (viagemId, pontosEmMemoria) {
      await this.save(viagemId, pontosEmMemoria || []);
    },
    takeAll: async function (viagemId) {
      var list = await this.load(viagemId);
      await prefRemove(this._key(viagemId));
      return list;
    },
    clear: async function (viagemId) {
      await prefRemove(this._key(viagemId));
    },
  };

  // ---------- Foreground Service (Android nativo, viagem ativa) ----------
  async function startTripTracking(opts) {
    if (!isNative()) return false;
    try {
      var T = plugin("TripTracking");
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
      var T = plugin("TripTracking");
      if (T && typeof T.stop === "function") {
        await T.stop();
        return true;
      }
    } catch (e) {
      console.warn("TripTracking.stop:", e && e.message);
    }
    return false;
  }

  async function watchPositionNative(onOk, onErr, options) {
    var G = plugin("Geolocation");
    if (!G || typeof G.watchPosition !== "function") return null;
    try {
      var id = await G.watchPosition(options || { enableHighAccuracy: true, timeout: 12000 }, function (pos, err) {
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
    var G = plugin("Geolocation");
    if (!G || id == null) return;
    try {
      await G.clearWatch({ id: id });
    } catch (_) {}
  }

  // Prefixa /api/... com o host de produção no app nativo com bundle local.
  // PWA e server.url remoto: no-op (mesma origem).
  function installFetchPatch() {
    if (global.__vapFetchPatched) return;
    if (typeof global.fetch !== "function") return;
    var orig = global.fetch.bind(global);
    global.fetch = function (input, init) {
      try {
        if (typeof input === "string" && input.charAt(0) === "/") {
          input = apiUrl(input);
        } else if (input && typeof input.url === "string" && input.url.charAt(0) === "/") {
          input = apiUrl(input.url);
        }
      } catch (_) {}
      return orig(input, init);
    };
    global.__vapFetchPatched = true;
  }

  installFetchPatch();

  global.VapPlatform = {
    isNative: isNative,
    plugin: plugin,
    apiBase: apiBase,
    apiUrl: apiUrl,
    DEFAULT_API_HOST: DEFAULT_API_HOST,
    prefGet: prefGet,
    prefSet: prefSet,
    prefRemove: prefRemove,
    RouteBuffer: RouteBuffer,
    startTripTracking: startTripTracking,
    stopTripTracking: stopTripTracking,
    watchPositionNative: watchPositionNative,
    clearWatchNative: clearWatchNative,
  };
})(typeof window !== "undefined" ? window : globalThis);
