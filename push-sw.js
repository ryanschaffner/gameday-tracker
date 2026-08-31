// Push-only service worker for the viewer (assistant) and parents pages.
// These pages are online-only, so this SW does no caching — it exists purely to receive push
// notifications and open the right page when tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: "Game Day", body: "Update" }; }
  const title = data.title || "Game Day";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: true,
    data: { url: data.url || "" },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  // Open the page this notification points at (parents.html?s=... etc.), preserving the current
  // origin/path. If a matching tab is open, focus it instead.
  const rel = (e.notification.data && e.notification.data.url) || "";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cls) => {
      for (const c of cls) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow && rel) return self.clients.openWindow(rel);
    })
  );
});
