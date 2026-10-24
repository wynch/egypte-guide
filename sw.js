/* Service worker — Bible de voyage Égypte.
 * Offline-first: after the first visit the app runs fully offline (plane,
 * desert, roaming off). CACHE_VERSION is injected by build.py (content hash)
 * and equals the <meta name="build"> of the page shipped with it.
 *
 * Invariants (see AGENT.md « Mises à jour de l'app installée »):
 * - The page body crosses the network once per version. One page key, "./"
 *   (manifest start_url, public link). Every page navigation in scope ("./",
 *   "./?v=…", "./index.html", any hash) is answered from it; the network is
 *   used only when no page is cached. Other in-scope navigations go to the
 *   network, uncached, and fall back to the cached page when it fails.
 * - Precache fetches use cache:"no-cache": the browser revalidates its HTTP
 *   entry (ETag / Last-Modified), so the install that follows a first page
 *   load costs a 304. Freshness guard: a page whose <meta name="build"> is not
 *   CACHE_VERSION is refetched once with cache:"reload"; if it still differs
 *   the install fails, the old worker stays in charge and the next update
 *   check retries. Nothing is written before every entry is fetched and checked.
 *   A guard failure after the reload leg leaves a marker (META cache) that
 *   skips the reload leg for that version for RELOAD_BACKOFF_MS; the no-cache
 *   leg always runs, so a fixed CDN is picked up at the next check.
 * - The manifest and icons are not build-checked (accepted: they rarely change
 *   and a stale one is harmless).
 * - No runtime caching: same-origin requests outside the precache (the zip,
 *   anything else) and all cross-origin requests (rate and weather APIs,
 *   cached by the app in localStorage) go to the network, never stored here.
 * - Messages: GET_VERSION → VERSION, SKIP_WAITING; ACTIVATED is posted to every
 *   open page on activation (an iOS standalone app resumed from memory never
 *   navigates again).
 */
const CACHE_VERSION = "bf667a3001f1";
// The origin (wynch.github.io) hosts other apps; only names under this prefix
// belong to the guide, and only those are ever deleted.
const CACHE_PREFIX = "egypte-guide-";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const META = CACHE_PREFIX + "meta";
const FAILED_KEY = "failed";
const RELOAD_BACKOFF_MS = 3 * 60 * 60 * 1000;

const PAGE = "./";
const ASSETS = [
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
];

const SCOPE = new URL("./", self.location.href);
const PAGE_PATHS = [SCOPE.pathname, SCOPE.pathname + "index.html"];
const ASSET_URLS = ASSETS.map((a) => new URL(a, SCOPE).href);

function fetchOk(url, mode) {
  return fetch(new Request(url, { cache: mode })).then((res) => {
    if (!res || !res.ok) throw new Error("precache " + url + ": HTTP " + (res && res.status));
    return res;
  });
}

function buildOf(res) {
  return res
    .clone()
    .text()
    .then((html) => {
      const m = html.match(/<meta name="build" content="([^"]*)">/);
      return m ? m[1] : null;
    });
}

function recentFailure() {
  return caches
    .match(FAILED_KEY, { cacheName: META })
    .then((res) => (res ? res.json() : null))
    .then((m) => !!m && m.version === CACHE_VERSION && Date.now() - m.time < RELOAD_BACKOFF_MS)
    .catch(() => false);
}

function markFailure() {
  const body = JSON.stringify({ version: CACHE_VERSION, time: Date.now() });
  return caches
    .open(META)
    .then((cache) => cache.put(FAILED_KEY, new Response(body, { headers: { "content-type": "application/json" } })))
    .catch(() => undefined);
}

// Resolves only with a page of this worker's version.
function fetchPage() {
  const mismatch = (b) => new Error("precache: page build " + b + " is not " + CACHE_VERSION);
  return fetchOk(PAGE, "no-cache").then((res) =>
    buildOf(res).then((build) => {
      if (build === CACHE_VERSION) return res;
      return recentFailure().then((skip) => {
        if (skip) throw mismatch(build);
        return fetchOk(PAGE, "reload").then((again) =>
          buildOf(again).then((b) => {
            if (b === CACHE_VERSION) return again;
            return markFailure().then(() => {
              throw mismatch(b);
            });
          })
        );
      });
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([fetchPage(), Promise.all(ASSETS.map((url) => fetchOk(url, "no-cache")))])
      .then(([page, assets]) =>
        caches
          .open(CACHE_NAME)
          .then((cache) => Promise.all([cache.put(PAGE, page), ...assets.map((res, i) => cache.put(ASSETS[i], res))]))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME && k !== META).map((k) => caches.delete(k))))
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

// This version's cache only: the worker never serves a page of another build.
function fromCache(key) {
  return caches.match(key, { cacheName: CACHE_NAME, ignoreVary: true }).catch(() => undefined);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== SCOPE.origin) return;

  if (req.mode === "navigate") {
    const offlinePage = () => fromCache(PAGE).then((p) => p || Response.error());
    if (!PAGE_PATHS.includes(url.pathname)) {
      // Other in-scope navigations (e.g. a link to the zip) are downloads, not the app.
      if (url.pathname.startsWith(SCOPE.pathname)) event.respondWith(fetch(req).catch(offlinePage));
      return;
    }
    event.respondWith(fromCache(PAGE).then((page) => page || fetch(req).catch(offlinePage)));
    return;
  }

  url.hash = "";
  if (!ASSET_URLS.includes(url.href)) return;
  event.respondWith(fromCache(url.href).then((res) => res || fetch(req)));
});
