// StaffPlan Service Worker — minimal, just enough to enable PWA install
const CACHE_NAME = "staffplan-v1";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// Network-first strategy — always fetch fresh data, fall back to cache
self.addEventListener("fetch", (e) => {
  // Only cache same-origin requests, skip Supabase/external API calls
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
