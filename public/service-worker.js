// Vagão Service Worker — estratégia network-first.
// Sempre tenta buscar a versão mais nova online; o cache é só fallback offline.
// Combinado com o auto-reload do pwa.js, o usuário recebe cada atualização
// publicada no Render automaticamente, sem reinstalar o app.
const CACHE = "vagao-cache-v1";

self.addEventListener("install", () => {
  // Ativa a nova versão imediatamente, sem esperar abas antigas fecharem.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Remove caches de versões anteriores.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Não intercepta outras origens (Google Maps, Supabase, CDN do Tesseract...).
  if (url.origin !== self.location.origin) return;
  // Nunca cacheia chamadas de API — sempre vão à rede.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw err;
      }
    })()
  );
});
