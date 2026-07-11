// Minimal service worker so Game Day Tracker keeps working with no signal at the field.
// Strategy: try the network first (so you always get the latest deployed version when
// online), and fall back to whatever's cached if the network fails. This is a single-page,
// no-backend app, so there's nothing else to cache — just the page itself.
const CACHE = "gameday-tracker-v1";

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.add(self.registration.scope))
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((r) => r || caches.match(self.registration.scope))
      )
  );
});
