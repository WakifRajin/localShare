/* localShare service worker — makes the app installable and lets it open offline.
 * Strategy: pages are network-first (you always get the newest version when online, the cached copy when not);
 * static assets are stale-while-revalidate. The relay API and the diagnostics terminal are never cached. */
const VERSION = 'v1';
const CACHE = `localshare-${VERSION}`;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('localshare-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                       // brokers, ntfy, STUN etc. go straight to the network
  if (/\/(api|term)\//.test(url.pathname)) return;                       // relay + terminal bridge: never cache

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then(hit => {
      const refresh = fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; }).catch(() => hit);
      return hit || refresh;
    })
  );
});
