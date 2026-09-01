// Minimal service worker so Game Day Tracker keeps working with no signal at the field.
// Strategy: try the network first (so you always get the latest deployed version when
// online), and fall back to whatever's cached if the network fails. This is a single-page,
// no-backend app, so there's nothing else to cache — just the page itself.
const CACHE = "gameday-tracker-v10";

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
  // Only handle same-origin page/asset requests. Cross-origin calls (e.g. the sharing Worker API)
  // must always hit the network directly so viewers get fresh data and flags post reliably.
  if (new URL(e.request.url).origin !== self.location.origin) return;
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

// ---- Push notifications ----
// The Worker sends an encrypted JSON payload {title, body, tag, url}. Show it as a notification.
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: "Game Day", body: (e.data && e.data.text && e.data.text()) || "Update" }; }
  const title = data.title || "Game Day Tracker";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,        // same tag collapses duplicates (e.g. repeated goal)
    renotify: true,
    data: { url: data.url || "index.html" },
    icon: "icon-192.png",
    badge: "icon-192.png",
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Tapping a notification focuses an open tab if there is one, else opens the target page.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "index.html";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cls) => {
      for (const c of cls) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
