const CACHE = 'fotoalert-v7';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js', 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'];
const BYPASS = ['overpass', 'nominatim.openstreetmap.org', 'routing.openstreetmap.de', 'router.project-osrm.org', 'photon.komoot.io'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
async function trim(cache, max) {
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.pathname.startsWith('/api/') || BYPASS.some(h => r.url.includes(h))) return;
  const own = u.origin === self.location.origin;
  // własne pliki: najpierw sieć (świeża wersja), w razie braku internetu pamięć podręczna
  if (own) {
    e.respondWith(fetch(r).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); }
      return res;
    }).catch(() => caches.match(r).then(h => h || caches.match('./index.html'))));
    return;
  }
  // kafelki mapy i Leaflet: najpierw pamięć podręczna
  e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => {
    if (res.ok && (r.url.includes('tile.openstreetmap.org') || r.url.includes('unpkg.com') || (r.url.includes('openfreemap.org') && !r.url.includes('/styles/')))) {
      const cp = res.clone();
      caches.open(CACHE).then(async c => { await c.put(r, cp); trim(c, 600); });
    }
    return res;
  })));
});
