// Vagão Service Worker.
// Objetivo: o app NÃO é offline, mas não pode quebrar sem internet — ele abre e
// mostra a última versão carregada. O cache é FIXO (só o "esqueleto" do app),
// sobrescreve em vez de acumular, e os dados de API nunca são cacheados.
const VERSION = "v74";
const CACHE = `vagao-shell-${VERSION}`;

// Lista fixa de arquivos do app (o cache nunca cresce além disto).
const SHELL = [
  "/",
  "/index.html",
  "/registro.html",
  "/dashboard.html",
  "/historico.html",
  "/admin.html",
  "/style.css",
  "/app.js",
  "/logo-vap.png",
  "/pwa.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Remove qualquer cache de versão anterior — nada de lixo acumulado.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

// Notificações push: o servidor manda um JSON {title, body, url} e o SW mostra
// a notificação mesmo com o app fechado.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || "VAP";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    vibrate: [250, 120, 250],   // duas vibradas firmes, igual à buzina do app aberto
    data: { url: data.url || "/dashboard.html" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Toque na notificação: foca uma aba já aberta ou abre o app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const alvo = (event.notification.data && event.notification.data.url) || "/dashboard.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientes) => {
      for (const c of clientes) {
        if (c.url.includes(alvo) && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(alvo);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Outras origens (Google Maps, Supabase, CDN do Tesseract) passam direto.
  if (url.origin !== self.location.origin) return;
  // API nunca é cacheada: dados de carona sempre vêm da rede.
  if (url.pathname.startsWith("/api/")) return;

  // Páginas (navegação): rede primeiro; offline, serve a última página em cache.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Sobrescreve a cópia desta página no cache (não acumula entradas novas).
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match("/index.html")))
    );
    return;
  }

  // Assets do esqueleto (css/js/ícones): cache primeiro, com atualização em
  // segundo plano. Só re-cacheia o que JÁ faz parte do shell — mantém o cache fixo.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (cached) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
