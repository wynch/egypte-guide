/* Service worker — Bible de voyage Égypte.
 * Cache-first, precache complet : après la 1re visite, l'app fonctionne
 * 100 % hors-ligne (avion, désert, roaming coupé).
 * CACHE_VERSION est injecté par build.py (hash du contenu) pour invalider
 * automatiquement le cache à chaque nouveau build.
 *
 * Mises à jour (voir AGENT.md « Mises à jour de l'app installée ») :
 * precache toujours frais (cache:"reload", jamais l'HTTP cache) pour ne pas
 * figer une page stale sous le nouveau nom de cache ; messages GET_VERSION /
 * SKIP_WAITING pour l'app ; notification ACTIVATED à toutes les pages ouvertes
 * (une app iOS standalone reprise depuis la mémoire ne re-navigue jamais).
 */
const CACHE_VERSION = "675b4cfd9573";
const CACHE_NAME = "egypte-guide-" + CACHE_VERSION;

const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((clients) => {
        for (const c of clients) c.postMessage({ type: "ACTIVATED", version: CACHE_VERSION });
      })
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type === "GET_VERSION") {
    const reply = { type: "VERSION", version: CACHE_VERSION };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Exception offline : les requêtes cross-origin (APIs taux de change + météo)
  // passent directement au réseau — jamais servies depuis le cache SW, jamais
  // mises en cache SW. Le cache applicatif de ces données, c'est le localStorage.
  let sameOrigin = true;
  try { sameOrigin = new URL(req.url).origin === self.location.origin; } catch (e) {}
  if (!sameOrigin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Met en cache les réponses valides de même origine pour les visites suivantes.
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // Hors-ligne : pour toute navigation, on sert la page principale en cache.
          if (req.mode === "navigate") return caches.match("./index.html");
          return caches.match(req);
        });
    })
  );
});
