// Service worker: gör att appen startar även utan nät och kan visa notiser.
const CACHE = "bildagboken-v160";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase-config.js",
  "./maps-config.js",
  "./car-models.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/logo.svg",
  "./icons/logo-dark.svg",
  "./icons/logo-symbol.svg",
  "./integritet.html",
  "./privacy.html",
  "./en.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Appens egna filer: hämta nytt först, använd sparad kopia utan nät.
  if (url.origin === self.location.origin) {
    event.respondWith(
      // no-cache: fråga alltid servern om filen ändrats, så att nya versioner syns direkt.
      fetch(req, { cache: "no-cache" })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }

  // Firebase-biblioteken ändras aldrig för en viss version: spara och återanvänd.
  if (url.host === "www.gstatic.com") {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        // Spara bara lyckade svar, annars fastnar ett tillfälligt fel i cachen.
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
  }
});

// Pushnotiser från Firebase: visa alltid en notis (iPhone kräver det för varje push).
self.addEventListener("push", (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) { p = { data: { body: event.data && event.data.text() } }; }
  const d = p.data || {};
  const n = p.notification || {};
  const title = n.title || d.title || "Bildagboken";
  event.waitUntil(self.registration.showNotification(title, {
    body: n.body || d.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: d.tag || undefined,
    data: { url: d.url || "./#aviseringar" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./#aviseringar";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
