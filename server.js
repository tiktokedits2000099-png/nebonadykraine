// «Небо над Украиной»: сервер игры, таблица лидеров и счётчик онлайна.
// Без зависимостей: нужен только Node.js 18+.  Запуск: node server.js  (порт: PORT, по умолчанию 3000)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = +process.env.PORT || 3000;
// Если заданы ключи Upstash Redis, таблица хранится там (не пропадает на бесплатном Render).
const REDIS = !!((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN));
const redisApi = REDIS ? require(fs.existsSync(path.join(__dirname, 'lib', 'redis-api.js')) ? './lib/redis-api.js' : './redis-api.js') : null;
// Игра ищется в папке public, а если её нет, то рядом с server.js (на случай, если index.html залили в корень репозитория)
const ROOT = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const HIDDEN = /^\/(server\.js|redis-api\.js|package(-lock)?\.json|render\.yaml|lib\/|data\/|\.git|node_modules)/i;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'scores.json');
const ONLINE_WINDOW = 60 * 1000;   // игрок считается онлайн 60 с после последнего сигнала
const TOP_N = 50;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- хранилище ---------- */
let db = { players: {} };            // id -> {name, nights, shot, launched, won, at, run}
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); if (!db.players) db.players = {}; } catch (_) {}
let dirty = false;
function persist() {
  if (!dirty) return; dirty = false;
  const tmp = DB_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), err => { if (!err) fs.rename(tmp, DB_FILE, () => {}); });
}
setInterval(persist, 5000).unref();
process.on('SIGINT', () => { dirty = true; try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (_) {} process.exit(0); });
process.on('SIGTERM', () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (_) {} process.exit(0); });

/* ---------- онлайн ---------- */
const online = new Map();            // id -> lastSeen
function onlineCount() {
  const now = Date.now(); let n = 0;
  for (const [id, t] of online) { if (now - t > ONLINE_WINDOW) online.delete(id); else n++; }
  return n;
}

/* ---------- защита от спама ---------- */
const hits = new Map();              // ip|bucket -> {n, t}
function limited(ip, bucket, max, perMs) {
  const k = ip + '|' + bucket, now = Date.now();
  const h = hits.get(k);
  if (!h || now - h.t > perMs) { hits.set(k, { n: 1, t: now }); return false; }
  h.n++; return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 120000) hits.delete(k); }, 60000).unref();

const runs = new Map();              // run -> {nights, t}  (проверка правдоподобия прогресса)

function cleanName(s) {
  s = String(s || '').normalize('NFKC').replace(/[\x00-\x1f\x7f<>]/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/[^\p{L}\p{N} _\-.!?#]/gu, '').slice(0, 18).trim();
  return s.length >= 2 ? s : null;
}
const int = (v, lo, hi) => { v = Math.floor(Number(v)); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
const better = (a, b) => (a.nights - b.nights) || (a.shot - b.shot);   // >0: a лучше

function ranked() {
  return Object.entries(db.players)
    .sort((x, y) => better(y[1], x[1]) || (x[1].at - y[1].at));
}
function rankOf(id) { const r = ranked(); const i = r.findIndex(([pid]) => pid === id); return { rank: i + 1, total: r.length }; }

/* ---------- API ---------- */
function api(req, res, url, body, ip) {
  const send = (code, obj) => { const s = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(s); };
  const id = body && typeof body.id === 'string' ? body.id.slice(0, 64) : null;

  if (url.pathname === '/api/hb' && req.method === 'POST') {
    if (limited(ip, 'hb', 12, 60000)) return send(429, { error: 'Слишком часто' });
    if (id) online.set(id, Date.now());
    return send(200, { online: onlineCount() });
  }
  if (url.pathname === '/api/online' && req.method === 'GET') return send(200, { online: onlineCount() });

  if (url.pathname === '/api/top' && req.method === 'GET') {
    const me = (url.searchParams.get('id') || '').slice(0, 64);
    const r = ranked();
    const top = r.slice(0, TOP_N).map(([pid, p]) => ({ name: p.name, nights: p.nights, shot: p.shot, won: !!p.won, me: pid === me }));
    const i = r.findIndex(([pid]) => pid === me);
    return send(200, { top, total: r.length, online: onlineCount(), me: i >= 0 ? { rank: i + 1, name: r[i][1].name, nights: r[i][1].nights, shot: r[i][1].shot } : null });
  }

  if (url.pathname === '/api/name' && req.method === 'POST') {
    if (limited(ip, 'name', 6, 60000)) return send(429, { error: 'Слишком часто, подождите минуту' });
    const name = cleanName(body && body.name);
    if (!id || !name) return send(400, { error: 'Позывной: 2–18 букв или цифр' });
    const taken = Object.entries(db.players).some(([pid, p]) => pid !== id && p.name.toLowerCase() === name.toLowerCase());
    if (taken) return send(409, { error: 'Такой позывной уже занят' });
    if (db.players[id]) { db.players[id].name = name; dirty = true; }
    else { db.players[id] = { name, nights: 0, shot: 0, launched: 0, won: false, at: Date.now(), run: '' }; dirty = true; }
    return send(200, { name });
  }

  if (url.pathname === '/api/restore' && req.method === 'POST') {
    // самовосстановление таблицы после перезапуска сервера: игрок присылает свой лучший результат с устройства
    if (limited(ip, 'restore', 4, 60000)) return send(429, { error: 'Слишком часто' });
    const nights = int(body.nights, 0, 300), shot = int(body.shot, 0, 1e7), launched = int(body.launched, 0, 1e7);
    let name = cleanName(body.name);
    if (!id || !name || nights == null || shot == null || launched == null) return send(400, { error: 'Неверные данные' });
    if (shot > launched || shot > 120 + nights * nights * 25 + nights * 150) return send(400, { error: 'Неправдоподобный результат' });
    const cur = db.players[id];
    if (!cur) {
      if (Object.entries(db.players).some(([pid, q]) => pid !== id && q.name.toLowerCase() === name.toLowerCase())) name = name.slice(0, 13) + '-' + id.slice(0, 4);
      db.players[id] = { name, nights, shot, launched, won: nights >= 12, at: Date.now(), run: '', restored: true }; dirty = true;
    } else if (better({ nights, shot }, cur) > 0) { Object.assign(cur, { nights, shot, launched, won: nights >= 12, restored: true }); dirty = true; }
    const { rank, total } = rankOf(id);
    return send(200, { name: db.players[id].name, rank, total, online: onlineCount() });
  }
  if (url.pathname === '/api/score' && req.method === 'POST') {
    if (limited(ip, 'score', 8, 60000)) return send(429, { error: 'Слишком часто' });
    const nights = int(body.nights, 0, 1000), shot = int(body.shot, 0, 1e7), launched = int(body.launched, 0, 1e7);
    const run = typeof body.run === 'string' ? body.run.slice(0, 40) : '';
    if (!id || nights == null || shot == null || launched == null || !run) return send(400, { error: 'Неверные данные' });
    if (shot > launched || shot > 120 + nights * nights * 25 + nights * 150) return send(400, { error: 'Неправдоподобный результат' });
    // прогресс партии: не больше одной ночи за раз и не чаще чем раз в 15 секунд
    const now = Date.now(), pr = runs.get(run);
    if (pr) { if (nights > pr.nights + 1 || (nights > pr.nights && now - pr.t < 15000)) return send(400, { error: 'Неправдоподобный прогресс' }); }
    else if (nights > 1) { /* партия началась до перезапуска сервера — допускаем, но не выше личного рекорда + 1 */
      const old = db.players[id]; if (nights > (old ? old.nights : 0) + 1 && nights > 1) return send(400, { error: 'Неправдоподобный прогресс' });
    }
    runs.set(run, { nights: Math.max(nights, pr ? pr.nights : 0), t: now });
    if (runs.size > 50000) runs.clear();

    let name = cleanName(body.name) || ('Командир-' + id.slice(0, 4));
    const cur = db.players[id];
    if (!cur) {
      if (Object.entries(db.players).some(([, p]) => p.name.toLowerCase() === name.toLowerCase())) name = name.slice(0, 13) + '-' + id.slice(0, 4);
    } else name = cur.name;
    const entry = { name, nights, shot, launched, won: !!body.won, at: now, run };
    let best = false;
    if (!cur || better(entry, cur) > 0) { db.players[id] = entry; best = !!cur || nights > 0; dirty = true; }
    const { rank, total } = rankOf(id);
    return send(200, { rank, total, best, online: onlineCount() });
  }
  return send(404, { error: 'Not found' });
}

/* ---------- статика ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
const cache = new Map();
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  if (HIDDEN.test(p)) { res.writeHead(404); return res.end(); }
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /text|javascript|json|svg/.test(type);
    const key = file + (gz ? ':gz' : '') + ':' + st.mtimeMs;
    const headers = { 'Content-Type': type, 'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' };
    const done = buf => { if (gz) headers['Content-Encoding'] = 'gzip'; headers['Content-Length'] = buf.length; res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : buf); };
    if (cache.has(key)) return done(cache.get(key));
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(500); return res.end(); }
      if (gz) buf = zlib.gzipSync(buf, { level: 9 });
      cache.set(key, buf); done(buf);
    });
  });
}

http.createServer((req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  let url; try { url = new URL(req.url, 'http://x'); } catch (_) { res.writeHead(400); return res.end(); }
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let raw = '', size = 0;
  req.on('data', c => { size += c.length; if (size > 4096) { res.writeHead(413); res.end(); req.destroy(); } else raw += c; });
  req.on('end', () => {
    if (res.writableEnded) return;
    let body = {}; if (raw) { try { body = JSON.parse(raw) || {}; } catch (_) { res.writeHead(400); return res.end('{"error":"bad json"}'); } }
    if (redisApi) {
      const rq = { method: req.method, headers: req.headers, query: { ...Object.fromEntries(url.searchParams), op: url.pathname.slice(5) }, body };
      const rs = { setHeader: (k, v) => res.setHeader(k, v), status(c) { res.statusCode = c; return this; }, end: d => res.end(d) };
      return redisApi(rq, rs).catch(e => { console.error(e); if (!res.headersSent) { res.writeHead(500); res.end('{"error":"server"}'); } });
    }
    try { api(req, res, url, body, ip); } catch (e) { console.error(e); if (!res.headersSent) { res.writeHead(500); res.end('{"error":"server"}'); } }
  });
}).listen(PORT, () => console.log(`Небо над Украиной: порт ${PORT}, таблица: ${REDIS ? 'Upstash Redis' : 'файл ' + DB_FILE}`));
