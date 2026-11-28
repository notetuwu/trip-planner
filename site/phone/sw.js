// Keeps the phone viewer (index.html) usable without a connection: the page itself, and what trip files load from
// elsewhere when they first can (the map library and its style, fonts), kept for the next time. Map tiles are not kept.
// The trips themselves never pass through here: they are files on the phone, kept by the page.
const CACHE = "trip-phone-viewer-v1";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon.png"];
const KEEP = /^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = e.request.url, own = url.startsWith(self.registration.scope);
  if (e.request.method !== "GET" || (!own && !KEEP.test(url))) return;
  // The page: the newest when there's a connection, else the kept one. The rest: the kept one, fetched once.
  e.respondWith(own
    ? fetch(e.request).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html")))
    : caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })));
});
