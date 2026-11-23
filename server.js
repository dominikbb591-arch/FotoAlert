'use strict';
/*
 * Fotoalert – serwer bez zależności (tylko Node.js >= 18).
 *  - serwuje aplikację z katalogu public/
 *  - POST /api/ping    heartbeat: licznik online + zgłoszenia i ceny w widocznym obszarze mapy
 *  - POST /api/leave   użytkownik wyszedł z aplikacji (przestaje być liczony)
 *  - POST /api/report  nowe zgłoszenie (policja, wypadek, zwierzę...)
 *  - POST /api/vote    "nadal tu jest" / "już nie ma"
 *  - POST /api/price   ceny paliw na stacji (zgłaszane przez użytkowników)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 3000;
// Pliki aplikacji mogą leżeć w folderze public/ albo obok server.js (płaski układ, wygodny przy wgrywaniu z telefonu).
const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const STATIC_FILES = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon.svg']);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// czas życia zgłoszenia w minutach
const TTL = { police: 90, camera: 120, accident: 150, stopped: 60, animal: 60, obstacle: 60, lane: 180,
  closed: 240, jam: 45, roadwork: 360, ice: 180, fog: 120, pothole: 1440,
  breakdown: 90, debris: 90, rockfall: 240, detour: 480 };
const FUELS = ['pb95', 'pb98', 'on', 'lpg'];
const ONLINE_MS = 45000;

const reports = new Map();
const prices = new Map();
const online = new Map();

/* ---------- zapis na dysk (opcjonalny, przeżywa restart jeśli dysk jest trwały) ---------- */
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  (d.reports || []).forEach(r => { r.voters = new Set(r.voters || []); reports.set(r.id, r); });
  (d.prices || []).forEach(p => prices.set(p.sid, p));
} catch (e) { /* pierwszy start */ }

let saveT = null;
function markDirty() {
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    try {
      const out = { reports: [...reports.values()].map(r => Object.assign({}, r, { voters: [...r.voters] })), prices: [...prices.values()] };
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { /* dysk tylko do odczytu – trudno */ }
  }, 5000);
}

/* ---------- pomocnicze ---------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
function send(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 8192) { reject(new Error('big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const hits = new Map();
function limited(key, max, win) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now > h.reset) { h = { n: 0, reset: now + win }; hits.set(key, h); }
  h.n++;
  return h.n > max;
}
function hav(a, b, c, d) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const p = r(c - a), q = r(d - b);
  const x = Math.sin(p / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(q / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const okLat = v => typeof v === 'number' && isFinite(v) && v >= -90 && v <= 90;
const okLon = v => typeof v === 'number' && isFinite(v) && v >= -180 && v <= 180;
function parseBBox(x) {
  if (!Array.isArray(x) || x.length !== 4 || !x.every(n => typeof n === 'number' && isFinite(n))) return null;
  const [s, w, n, e] = x;
  if (!(s < n && w < e) || n - s > 2 || e - w > 3 || !okLat(s) || !okLat(n) || !okLon(w) || !okLon(e)) return null;
  return { s, w, n, e };
}
const inBox = (b, lat, lon) => lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;
const pubReport = r => ({ id: r.id, type: r.type, lat: r.lat, lon: r.lon, t: r.t, exp: r.exp, up: r.up, down: r.down });
function countOnline() {
  const now = Date.now(); let n = 0;
  for (const v of online.values()) if (now - v.t < ONLINE_MS) n++;
  return n;
}
function applyVote(r, id, v) {
  if (r.voters.has(id)) return false;
  r.voters.add(id);
  if (v > 0) {
    r.up++;
    r.exp = Math.max(r.exp, Date.now() + TTL[r.type] * 60000);
  } else {
    r.down++;
    if (id === r.by || (r.down >= 3 && r.down > r.up)) reports.delete(r.id);
  }
  markDirty();
  return true;
}

/* ---------- API ---------- */
async function api(req, res, url, ip) {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, online: countOnline(), reports: reports.size, prices: prices.size });
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (limited('ip:' + ip, 1200, 60000)) return send(res, 429, { error: 'rate' });

  let b;
  try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'json' }); }
  if (!b || typeof b !== 'object') return send(res, 400, { error: 'body' });
  const id = b.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,48}$/.test(id)) return send(res, 400, { error: 'id' });
  const now = Date.now();

  switch (url.pathname) {
    case '/api/ping': {
      if (limited('ping:' + id, 40, 60000)) return send(res, 429, { error: 'rate' });
      online.set(id, { t: now });
      const bb = parseBBox(b.bbox);
      const rl = [], pl = [];
      if (bb) {
        for (const r of reports.values()) if (r.exp > now && inBox(bb, r.lat, r.lon)) rl.push(pubReport(r));
        for (const p of prices.values()) if (inBox(bb, p.lat, p.lon)) pl.push(p);
      }
      return send(res, 200, { online: countOnline(), reports: rl.slice(0, 600), prices: pl.slice(0, 1500) });
    }
    case '/api/leave': {
      online.delete(id);
      return send(res, 200, { ok: true });
    }
    case '/api/report': {
      if (limited('rep:' + id, 12, 60000)) return send(res, 429, { error: 'rate' });
      if (typeof b.type !== 'string' || !Object.prototype.hasOwnProperty.call(TTL, b.type)) return send(res, 400, { error: 'type' });
      if (!okLat(b.lat) || !okLon(b.lon)) return send(res, 400, { error: 'pos' });
      // takie samo zgłoszenie w pobliżu: traktujemy jako potwierdzenie
      for (const r of reports.values()) {
        if (r.type === b.type && r.exp > now && hav(b.lat, b.lon, r.lat, r.lon) < 80) {
          if (r.by !== id) applyVote(r, id, 1);
          return send(res, 200, { report: pubReport(r), merged: true });
        }
      }
      if (limited('rep1h:' + id, 40, 3600000)) return send(res, 429, { error: 'rate' });
      const r = {
        id: now.toString(36) + Math.random().toString(36).slice(2, 6),
        type: b.type, lat: b.lat, lon: b.lon, t: now, exp: now + TTL[b.type] * 60000,
        up: 1, down: 0, by: id, voters: new Set()
      };
      reports.set(r.id, r);
      markDirty();
      return send(res, 200, { report: pubReport(r) });
    }
    case '/api/vote': {
      if (limited('vote:' + id, 60, 60000)) return send(res, 429, { error: 'rate' });
      const r = reports.get(String(b.rid || ''));
      if (!r) return send(res, 404, { error: 'gone' });
      const v = b.v > 0 ? 1 : -1;
      applyVote(r, id, v);
      return send(res, 200, { ok: true });
    }
    case '/api/price': {
      if (limited('price:' + id, 30, 3600000)) return send(res, 429, { error: 'rate' });
      const sid = b.sid;
      if (typeof sid !== 'string' || !/^[nwr]\d{1,12}$/.test(sid)) return send(res, 400, { error: 'sid' });
      if (limited('ps:' + id + sid, 3, 600000)) return send(res, 429, { error: 'rate' });
      let rec = prices.get(sid);
      if (!rec) {
        if (!okLat(b.lat) || !okLon(b.lon)) return send(res, 400, { error: 'pos' });
        rec = { sid, lat: b.lat, lon: b.lon, name: String(b.name || '').slice(0, 80), p: {} };
      }
      let n = 0;
      const src = b.p && typeof b.p === 'object' ? b.p : {};
      for (const f of FUELS) {
        const v = Number(src[f]);
        if (src[f] != null && isFinite(v) && v >= 1.5 && v <= 15) { rec.p[f] = { v: Math.round(v * 100) / 100, t: now }; n++; }
      }
      if (!n) return send(res, 400, { error: 'price' });
      if (prices.size >= 30000 && !prices.has(sid)) prices.delete(prices.keys().next().value);
      prices.set(sid, rec);
      markDirty();
      return send(res, 200, { ok: true, price: rec });
    }
    default:
      return send(res, 404, { error: 'route' });
  }
}

/* ---------- pliki statyczne ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  // serwujemy tylko pliki aplikacji, nigdy server.js, package.json ani danych
  if (!STATIC_FILES.has(p.replace(/^\/+/, ''))) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
  const f = path.join(PUB, p.replace(/^\/+/, ''));
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
    const ext = path.extname(f);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': (ext === '.html' || p === '/sw.js') ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const ip = (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
    if (url.pathname.startsWith('/api/')) return await api(req, res, url, ip);
    return serveStatic(req, res, url);
  } catch (e) {
    try { send(res, 500, { error: 'server' }); } catch (e2) { /* ignore */ }
  }
});

/* ---------- sprzątanie ---------- */
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [k, r] of reports) if (r.exp <= now) { reports.delete(k); changed = true; }
  for (const [k, v] of online) if (now - v.t > ONLINE_MS * 3) online.delete(k);
  for (const [k, p] of prices) {
    const newest = Math.max(0, ...Object.values(p.p).map(x => x.t));
    if (now - newest > 45 * 86400000) { prices.delete(k); changed = true; }
  }
  for (const [k, h] of hits) if (now > h.reset) hits.delete(k);
  if (changed) markDirty();
}, 60000).unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log('Fotoalert działa na porcie ' + PORT));
}
module.exports = server;
