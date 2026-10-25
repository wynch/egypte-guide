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
 * - The install holds only the page (~1.3 MB, no photos) and the icons.
 *   Precache fetches use cache:"no-cache": the browser revalidates its HTTP
 *   entry (ETag / Last-Modified), so the install that follows a first page
 *   load costs a 304. Freshness guard: a page whose <meta name="build"> is not
 *   CACHE_VERSION is refetched once with cache:"reload"; if it still differs
 *   the install fails, the old worker stays in charge and the next update
 *   check retries. Nothing is written before every entry is fetched and checked.
 *   A guard failure after the reload leg leaves a marker (META cache) that
 *   skips the reload leg for that version for RELOAD_BACKOFF_MS; the no-cache
 *   leg always runs, so a fixed CDN is picked up at the next check.
 * - Photos are files img/<sha256[:16]>.<ext> (IMAGE_FILES, injected by
 *   build.py), one entry each in the IMAGES cache, shared by every version: a
 *   name is its content, so an unchanged photo is never fetched again. They are
 *   fetched after activation, a few at a time, each retried (fillImages, run
 *   on FILL_IMAGES from the page and by any request for a missing one).
 *   Activation drops the names this version does not list. A photo not cached
 *   yet comes from the network; offline it fails and the page hides it.
 * - The manifest and icons are not build-checked (accepted: they rarely change
 *   and a stale one is harmless).
 * - No other runtime caching: same-origin requests outside the precache and
 *   the photo list (the zip, anything else) and all cross-origin requests (rate
 *   and weather APIs, cached by the app in localStorage) go to the network,
 *   never stored here.
 * - Every fetch here fails after STALL_MS without a byte (headers or body) or
 *   FETCH_CAP_MS in all, even if the browser ignores the abort; precache
 *   fetches retry once on a network error. An install never hangs.
 * - Messages: GET_VERSION → VERSION, SKIP_WAITING, FILL_IMAGES; ACTIVATED is
 *   posted to every open page on activation (an iOS standalone app resumed
 *   from memory never navigates again); INSTALL_FAILED { version, reason } on
 *   a failed install, also kept in META under "install-error".
 */
const CACHE_VERSION = "2812a9d95d13";
// The origin (wynch.github.io) hosts other apps; only names under this prefix
// belong to the guide, and only those are ever deleted.
const CACHE_PREFIX = "egypte-guide-";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const META = CACHE_PREFIX + "meta";
const IMAGES = CACHE_PREFIX + "img";
const FAILED_KEY = "failed";
const INSTALL_ERROR_KEY = "install-error";
const RELOAD_BACKOFF_MS = 3 * 60 * 60 * 1000;
const STALL_MS = 45 * 1000;
const FETCH_CAP_MS = 10 * 60 * 1000;
const IMAGE_TRIES = 3;
const IMAGE_CONCURRENCY = 3;
const IMAGE_FILES = ["0204ca255e3fab86.jpg", "029cd412373cecd7.jpg", "030e03e14cadd62f.jpg", "0619c0159b83bf3d.jpg", "067726da2c5daf3c.jpg", "078937a623cb1199.jpg", "093db6d1f9d9776e.jpg", "12caaf9a48611108.jpg", "12f473a286038fcc.jpg", "18d042af27fbac5e.jpg", "18ffe34730dabe79.jpg", "19b70f89d1e60b35.jpg", "1b60f3d73fc50cd0.jpg", "1d074934c1314304.jpg", "22e5c8eb8e919550.jpg", "235c187908ae487f.jpg", "269f8f8c1b091c8b.jpg", "26fd8505f5913a0c.jpg", "2b4443aa4a1eed27.jpg", "2c4641434314771a.jpg", "2c83632320c01513.jpg", "2d20dc37033e3229.jpg", "2e0ade0d0a7ed3f0.jpg", "2e1f588796c3efe2.jpg", "2ee170249ace58a7.jpg", "2f48fdddc5c9e8c7.jpg", "2f8f7bc3ca13ce4b.jpg", "2fe0720f6e7562a4.jpg", "31f3f00ae9166627.jpg", "346dd002d40dce4e.jpg", "348d130bfb687a7b.jpg", "35481b73c5819167.jpg", "366b674d6f27ce4b.jpg", "3759846de6cc5fa3.jpg", "382e9694470c5ed8.jpg", "3844e01a82c7296a.jpg", "39a2975921b235e8.jpg", "3d2361cee71e7313.jpg", "3d7243146ca423f8.jpg", "3ec02903817d2940.jpg", "3febddf2b98c1ab3.jpg", "44a498628ba66f84.jpg", "46793984db7036c9.jpg", "4bcbcaa62eeae4af.jpg", "4c578f4d145befb6.jpg", "4c8c1ee5dbb87e1e.jpg", "4e47c530dac596e1.jpg", "4ea1d2f7449c18ba.jpg", "4fca0c9e10936bb1.jpg", "50e3ff9f648a1c4f.jpg", "53b8828224c756fa.jpg", "546894fc03e13e0e.jpg", "5791bdfad41c2c5c.jpg", "596ad5104e3ef40e.jpg", "5b230e88d4b111a4.jpg", "5b4e435b6a688e3e.jpg", "5bcaa1e4e69ec8f3.jpg", "5e833e57f1aa6065.jpg", "5f2859666ba8c2a2.jpg", "5fdb73e8a1b33dda.jpg", "601a4b493d823695.jpg", "618f110ecb3b167f.jpg", "6195c8eace170dc6.jpg", "619e4614959281a4.jpg", "61b398914356fe52.jpg", "62f59731ec98463b.jpg", "656dc93d55c6c1ee.jpg", "69ccc7f18b6d13d7.jpg", "6a69b1d52cc420c6.jpg", "6b2561fec9be00d4.jpg", "6b4d42aac83229ce.jpg", "6bb940b76cc0aa23.jpg", "7224222251113f62.jpg", "73faf664b0b04604.jpg", "759474e1ab56afa6.jpg", "767cc5f8aa1c9205.jpg", "7b01b174f4fc41c9.jpg", "7e37f3a4b9793248.jpg", "7f2aa8999752daf4.jpg", "81b03dedf1ec2dd1.jpg", "82308e5d911466c0.jpg", "85630aa197a677d2.jpg", "87694c1af9cccc27.jpg", "894b7512c00898fb.jpg", "8aab46b8bca08cad.jpg", "8b70a616e1a7fffd.jpg", "8cb6e71014518e90.jpg", "8d6f0296a2b56be0.jpg", "8e710497d972f335.jpg", "8fa626811bee6ce6.jpg", "911f0dfa3722b54e.jpg", "9208c243876de320.jpg", "945fea51fc675599.jpg", "9523c30ce19c859f.jpg", "95b98c61a6c8dc5a.jpg", "96700b71bfae345e.jpg", "998f7c7e1bed2ef9.jpg", "99ff4059ef1c4a10.jpg", "9a55a3a097fbfa59.jpg", "9e0b2191b0191524.jpg", "9fd41e91be10c9f7.jpg", "a126737b7fbe6539.jpg", "a380e58c68e21453.jpg", "a52ed68fa0268444.jpg", "a780c662b6ce377d.jpg", "a832ef6acde39684.jpg", "a8980622a12c185f.jpg", "a96c0c8a5261f282.jpg", "a98560479d5fedbd.jpg", "a9d84526e9d02fb5.jpg", "aa7f71615d4590a6.jpg", "ab219f75026d8f00.jpg", "ab7339574713b3d7.jpg", "ad5b713c068a4a91.jpg", "ae015bd4a466c6f4.jpg", "afe873dc14e6f95d.jpg", "b2d4d6ce3b6f76e8.jpg", "b61603aec929f7b4.jpg", "b6303bab57f62ad6.jpg", "b65532de16c08dc4.jpg", "b74cfe1b30821f50.jpg", "b7f338e5d28d1605.jpg", "b8d41d01d321c95c.jpg", "b93ce00b6831d9ba.jpg", "b96563eef7a66a79.jpg", "bab3a077a61fcad3.jpg", "bc58eed3c81be909.jpg", "be55b6ea4eac1d95.jpg", "be6544d839da2ad6.jpg", "c17523749208f0b4.jpg", "c2a32b3a42cab082.jpg", "c69560bebcca2c4b.jpg", "cc1971e3928dbf1c.jpg", "cc3e7334678bb7e4.jpg", "ccc55a6116e745b8.jpg", "ced90d1e45998d92.jpg", "d0c9d45cebfcb9a2.jpg", "d25ecfda643760e0.jpg", "d2b2230feda3f050.jpg", "d4e1481683305911.jpg", "d6a9d71fc4d41b3a.jpg", "d79e0d933e92791e.jpg", "d8284101f7fe437d.jpg", "d86af393bbc4dd6d.jpg", "da09398b1c6b7d12.jpg", "da7cc58d05d1ea83.jpg", "df2a8a2a323138b8.jpg", "e072cff8e8d3f723.jpg", "e0ba96bae05dc07c.jpg", "e0f4b871ba2d75ec.jpg", "e1a602c462e2a14e.jpg", "e1bca1ec90f99b9b.jpg", "e329a61b91466c32.jpg", "e3c0efac922bdd94.jpg", "e452768c4d603d14.jpg", "e5c3691f58912044.jpg", "e722de59532f434c.jpg", "e728740773f12b75.jpg", "ea0709edcd53caf8.jpg", "eaa27ccd4c40e2a3.jpg", "eb0169d57f493a08.jpg", "ec4f22984dd96226.jpg", "ee239552dfef1240.jpg", "f01d251e1d837d9d.jpg", "f0f93b55406b3e5b.jpg", "f1d627d58f5d5f55.jpg", "f1f7c5190eed78e0.jpg", "f203f64c6cbab46f.jpg", "f2a5f6d73fa3fc44.jpg", "f3ef7fba699f2b66.jpg", "f4accd77b3112829.jpg", "f6ab597636d4635f.jpg", "f7ba52d257f143e1.jpg", "fa697ce99d69cc51.jpg", "fcb1aeffe0de9cf9.jpg", "fccc6f307ca81de4.jpg", "fecfcecebc80505a.jpg"];

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
const IMAGE_URLS = IMAGE_FILES.map((n) => new URL("img/" + n, SCOPE).href);
const IMAGE_SET = new Set(IMAGE_URLS);
const BUILD_PROBE_BYTES = 16 * 1024;
const BUILD_RE = /<meta name="build" content="([^"]*)">/;

function timeoutError(message) {
  const e = new Error(message);
  e.name = "TimeoutError";
  return e;
}

// Whole body as a Blob; onChunk runs at each chunk (resets the stall timer).
function readBody(res, onChunk) {
  if (!res.body || typeof res.body.getReader !== "function") return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  const pump = () =>
    reader.read().then(({ done, value }) => {
      if (done) return new Blob(chunks);
      chunks.push(value);
      onChunk();
      return pump();
    });
  return pump();
}

// Resolves with { body: Blob, type } once the whole body is read. Fails with a
// TimeoutError after STALL_MS without progress or FETCH_CAP_MS in all; the
// race settles even if the browser keeps the request going.
function fetchOk(url, mode) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const init = { cache: mode };
  if (ctrl) init.signal = ctrl.signal;
  let stall = null;
  let cap = null;
  let fail = null;
  const guard = new Promise((_, reject) => {
    fail = reject;
  });
  const stop = (message) => {
    fail(timeoutError(message));
    if (ctrl) ctrl.abort();
  };
  const arm = () => {
    clearTimeout(stall);
    stall = setTimeout(() => stop(url + ": no data for " + STALL_MS / 1000 + " s"), STALL_MS);
  };
  cap = setTimeout(() => stop(url + ": over " + FETCH_CAP_MS / 1000 + " s"), FETCH_CAP_MS);
  arm();
  const work = fetch(new Request(url, init)).then((res) => {
    if (!res || !res.ok) throw new Error("precache " + url + ": HTTP " + (res && res.status));
    arm();
    const type = (res.headers && res.headers.get("content-type")) || "";
    return readBody(res, arm).then((body) => ({ body, type }));
  });
  return Promise.race([work, guard]).finally(() => {
    clearTimeout(stall);
    clearTimeout(cap);
  });
}

// A response rebuilt from the bytes read: only content-type is kept, because
// content-encoding and content-length describe the compressed transfer.
function toResponse(got) {
  return new Response(got.body, { status: 200, headers: got.type ? { "content-type": got.type } : {} });
}

function buildOf(body) {
  const head = body.size > BUILD_PROBE_BYTES ? body.slice(0, BUILD_PROBE_BYTES) : body;
  return head.text().then((html) => {
    const m = html.match(BUILD_RE);
    if (m || head === body) return m ? m[1] : null;
    return body.text().then((all) => ((all.match(BUILD_RE) || [])[1] ?? null));
  });
}

function recentFailure() {
  return caches
    .match(FAILED_KEY, { cacheName: META })
    .then((res) => (res ? res.json() : null))
    .then((m) => !!m && m.version === CACHE_VERSION && Date.now() - m.time < RELOAD_BACKOFF_MS)
    .catch(() => false);
}

function putMeta(key, value) {
  const body = JSON.stringify(value);
  return caches
    .open(META)
    .then((cache) => cache.put(key, new Response(body, { headers: { "content-type": "application/json" } })))
    .catch(() => undefined);
}

function markFailure() {
  return putMeta(FAILED_KEY, { version: CACHE_VERSION, time: Date.now() });
}

// One retry on a network error (TypeError, AbortError, TimeoutError), none on an HTTP error.
function fetchRetry(url, mode) {
  return fetchOk(url, mode).catch((e) => {
    if (e && /^precache /.test(e.message || "")) throw e;
    return fetchOk(url, mode);
  });
}

const mismatch = (b) => new Error("precache: page build " + b + " is not " + CACHE_VERSION);

// The no-cache leg brought another build: its body is not kept while the
// reload leg runs.
function refetchPage(build) {
  return recentFailure().then((skip) => {
    if (skip) throw mismatch(build);
    return fetchRetry(PAGE, "reload").then((again) =>
      buildOf(again.body).then((b) => {
        if (b === CACHE_VERSION) return again;
        return markFailure().then(() => {
          throw mismatch(b);
        });
      })
    );
  });
}

// Resolves only with a page of this worker's version.
function fetchPage() {
  return fetchRetry(PAGE, "no-cache").then((got) =>
    buildOf(got.body).then((build) => (build === CACHE_VERSION ? got : refetchPage(build)))
  );
}

// A failed install is told to every open page (an older page's code ignores
// the message) and kept in META for the next page to show: the old worker
// stays in charge and the next update check retries.
function reportFailure(e) {
  const reason = ((e && e.name) || "Error") + ": " + String((e && e.message) || e).slice(0, 200);
  const info = { version: CACHE_VERSION, time: Date.now(), reason };
  return Promise.all([
    caches.delete(CACHE_NAME).catch(() => false),
    putMeta(INSTALL_ERROR_KEY, info),
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const c of clients) c.postMessage({ type: "INSTALL_FAILED", version: CACHE_VERSION, reason });
      })
      .catch(() => undefined),
  ]).then(() => {
    throw e;
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([fetchPage(), Promise.all(ASSETS.map((url) => fetchRetry(url, "no-cache")))])
      .then(([page, assets]) =>
        caches
          .open(CACHE_NAME)
          .then((cache) =>
            // One entry at a time, page first: a failed write stops the rest.
            cache.put(PAGE, toResponse(page)).then(() => Promise.all(assets.map((got, i) => cache.put(ASSETS[i], toResponse(got)))))
          )
      )
      .then(() => self.skipWaiting())
      .catch(reportFailure)
  );
});

/* ---------- photos: one cache entry per file, filled after activation ---------- */

function fetchImage(cache, url, left = IMAGE_TRIES) {
  return fetchOk(url, "default")
    .then((got) => cache.put(url, toResponse(got)))
    .catch((e) => {
      if (left <= 1) throw e;
      return fetchImage(cache, url, left - 1);
    });
}

let filling = null;

/** Fetches every listed photo not cached yet; resolves { total, missing }. */
function fillImages() {
  if (filling) return filling;
  filling = caches
    .open(IMAGES)
    .then((cache) =>
      cache.keys().then((reqs) => {
        const have = new Set(reqs.map((r) => r.url));
        const todo = IMAGE_URLS.filter((u) => !have.has(u));
        let next = 0;
        let missing = 0;
        const lane = () => {
          if (next >= todo.length) return undefined;
          const url = todo[next++];
          return fetchImage(cache, url)
            .catch(() => {
              missing++;
            })
            .then(lane);
        };
        const lanes = Array.from({ length: Math.min(IMAGE_CONCURRENCY, todo.length) }, lane);
        return Promise.all(lanes).then(() => ({ total: IMAGE_URLS.length, missing }));
      })
    )
    .catch(() => ({ total: IMAGE_URLS.length, missing: -1 }))
    .finally(() => {
      filling = null;
    });
  return filling;
}

function pruneImages() {
  return caches
    .has(IMAGES)
    .then((has) => (has ? caches.open(IMAGES) : null))
    .then((cache) =>
      cache && cache.keys().then((reqs) => Promise.all(reqs.filter((r) => !IMAGE_SET.has(r.url)).map((r) => cache.delete(r)))))
    .catch(() => undefined);
}

self.addEventListener("activate", (event) => {
  const keep = [CACHE_NAME, META, IMAGES];
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && !keep.includes(k)).map((k) => caches.delete(k))))
      .then(pruneImages)
      .then(() => caches.open(META).then((m) => m.delete(INSTALL_ERROR_KEY)).catch(() => false))
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
  if (data.type === "FILL_IMAGES") {
    if (event.waitUntil) event.waitUntil(fillImages());
    else fillImages();
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

function imageResponse(event, href) {
  return caches
    .match(href, { cacheName: IMAGES, ignoreVary: true })
    .catch(() => undefined)
    .then((hit) => {
      if (hit) return hit;
      // A missing photo is a cue that the fill did not finish: resume it.
      // waitUntil throws InvalidStateError once the event is over; the photo
      // response must not fail for it.
      try {
        if (event.waitUntil) event.waitUntil(fillImages());
        else fillImages();
      } catch (e) {
        fillImages();
      }
      return fetch(event.request);
    });
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
  const bare = url.origin + url.pathname;
  if (IMAGE_SET.has(bare)) {
    event.respondWith(imageResponse(event, bare));
    return;
  }
  if (!ASSET_URLS.includes(url.href)) return;
  event.respondWith(fromCache(url.href).then((res) => res || fetch(req)));
});
