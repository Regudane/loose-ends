/*
  Keeps the Loose Ends phone app working with a weak signal: the app's own files come from this phone first,
  and the fonts are kept once fetched. Anything from Microsoft (sign-in, OneDrive) always goes to the network
  and is never stored here. Change VERSION with every release so phones pick up the new files.
*/
const VERSION = "le-app-1.0.1";
const SHELL = ["./", "index.html", "styles.css", "config.js", "merge.js", "auth.js", "graph.js", "common.js", "board.js", "workhub.js", "app.js",
  "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"];
const FONTS = "le-fonts-1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONTS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", (e) => { if (e.data === "skip") self.skipWaiting(); });

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // The app's own files. Pages (including the return from Microsoft's sign-in) get the app's index.html.
    if (req.mode === "navigate") {
      e.respondWith(caches.match("index.html").then((r) => r || fetch(req)));
      return;
    }
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then((c) => c.match(req).then((hit) => {
      const net = fetch(req).then((r) => { if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    })));
  }
  // Everything else (Microsoft sign-in, Graph, OneDrive downloads): straight to the network, never stored.
});
