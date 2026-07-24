/* Service worker — Bible de voyage Égypte.
 * Cache-first, precache complet : après la 1re visite, l'app fonctionne
 * 100 % hors-ligne (avion, désert, roaming coupé).
 * CACHE_VERSION est injecté par build.py (hash du contenu) pour invalider
 * automatiquement le cache à chaque nouveau build.
 */
const CACHE_VERSION = "80f022c26982";
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
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

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
