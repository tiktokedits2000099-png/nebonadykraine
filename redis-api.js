// «Небо над Украиной»: API для Vercel (таблица лидеров + онлайн). Хранилище: Upstash Redis (бесплатный план).
'use strict';
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ONLINE_MS = 60 * 1000, TOP_N = 50;

async function R(cmds) {               // пакет команд Redis за один запрос
  const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis ' + r.status);
  const j = await r.json();
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const obj = a => { const o = {}; if (Array.isArray(a)) for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; };
function cleanName(s) {
  s = String(s || '').normalize('NFKC').replace(/[\x00-\x1f\x7f<>]/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/[^\p{L}\p{N} _\-.!?#]/gu, '').slice(0, 18).trim();
  return s.length >= 2 ? s : null;
}
const int = (v, lo, hi) => { v = Math.floor(Number(v)); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
const scoreOf = (nights, shot, at) => nights * 1e7 + Math.min(shot, 9999999) + (1e13 - at) / 1e13 * 0.99;
const minute = () => Math.floor(Date.now() / 60000);
const onlineCmds = () => [['ZREMRANGEBYSCORE', 'on', '-inf', String(Date.now() - ONLINE_MS)], ['ZCARD', 'on']];

module.exports = async function handler(req, res) {
  const send = (code, o) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.status(code).end(JSON.stringify(o)); };
  if (!URL_ || !TOKEN) return send(503, { error: 'База не подключена (Storage → Upstash Redis)' });
  const op = String(req.query.op || '');
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  let body = req.body || {}; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const id = typeof body.id === 'string' ? body.id.slice(0, 64).replace(/[^\w\-]/g, '') : null;
  const rl = (b, max) => [['INCR', `rl:${b}:${ip}:${minute()}`], ['EXPIRE', `rl:${b}:${ip}:${minute()}`, '70']];
  try {
    if (op === 'online' && req.method === 'GET') { const r = await R(onlineCmds()); return send(200, { online: r[1] }); }

    if (op === 'hb' && req.method === 'POST') {
      const r = await R([...rl('hb'), ...(id ? [['ZADD', 'on', String(Date.now()), id]] : []), ...onlineCmds()]);
      if (r[0] > 12) return send(429, { error: 'Слишком часто' });
      return send(200, { online: r[r.length - 1] });
    }

    if (op === 'top' && req.method === 'GET') {
      const me = String(req.query.id || '').slice(0, 64).replace(/[^\w\-]/g, '');
      const r = await R([['ZREVRANGE', 'lb', '0', String(TOP_N - 1)], ['ZCARD', 'lb'], ['ZREVRANK', 'lb', me || '-'], ['HGETALL', 'p:' + (me || '-')], ...onlineCmds()]);
      const ids = r[0] || [];
      const ps = ids.length ? await R(ids.map(x => ['HMGET', 'p:' + x, 'name', 'nights', 'shot', 'won'])) : [];
      const top = ids.map((x, i) => ({ name: ps[i][0] || 'Командир', nights: +ps[i][1] || 0, shot: +ps[i][2] || 0, won: ps[i][3] === '1', me: x === me }));
      const mp = obj(r[3]);
      return send(200, { top, total: r[1], online: r[5], me: r[2] != null && mp.name ? { rank: r[2] + 1, name: mp.name, nights: +mp.nights, shot: +mp.shot } : null });
    }

    if (op === 'name' && req.method === 'POST') {
      const name = cleanName(body.name);
      if (!id || !name) return send(400, { error: 'Позывной: 2–18 букв или цифр' });
      const low = name.toLowerCase();
      const r = await R([...rl('name'), ['HGET', 'names', low], ['HGET', 'p:' + id, 'name']]);
      if (r[0] > 6) return send(429, { error: 'Слишком часто, подождите минуту' });
      if (r[2] && r[2] !== id) return send(409, { error: 'Такой позывной уже занят' });
      if (r[3]) { const cmds = [['HSET', 'names', low, id], ['HSET', 'p:' + id, 'name', name]]; if (r[3].toLowerCase() !== low) cmds.push(['HDEL', 'names', r[3].toLowerCase()]); await R(cmds); }
      else { const now = Date.now(); await R([['HSET', 'names', low, id], ['HSET', 'p:' + id, 'name', name, 'nights', '0', 'shot', '0', 'launched', '0', 'won', '0', 'at', String(now)], ['ZADD', 'lb', String(scoreOf(0, 0, now)), id]]); }
      return send(200, { name });
    }

    if (op === 'restore' && req.method === 'POST') {
      const nights = int(body.nights, 0, 300), shot = int(body.shot, 0, 1e7), launched = int(body.launched, 0, 1e7);
      let name = cleanName(body.name);
      if (!id || !name || nights == null || shot == null || launched == null) return send(400, { error: 'Неверные данные' });
      if (shot > launched || shot > 120 + nights * nights * 25 + nights * 150) return send(400, { error: 'Неправдоподобный результат' });
      const r = await R([...rl('restore'), ['HGETALL', 'p:' + id]]);
      if (r[0] > 4) return send(429, { error: 'Слишком часто' });
      const cur = obj(r[2]); const has = !!cur.name; const now = Date.now();
      if (!has) { const t = await R([['HGET', 'names', name.toLowerCase()]]); if (t[0] && t[0] !== id) name = name.slice(0, 13) + '-' + id.slice(0, 4); }
      else name = cur.name;
      const better = !has || nights > +cur.nights || (nights === +cur.nights && shot > +cur.shot);
      if (better) await R([['HSET', 'p:' + id, 'name', name, 'nights', String(nights), 'shot', String(shot), 'launched', String(launched), 'won', nights >= 12 ? '1' : '0', 'at', String(now)], ['ZADD', 'lb', String(scoreOf(nights, shot, now)), id], ['HSETNX', 'names', name.toLowerCase(), id]]);
      const w = await R([['ZREVRANK', 'lb', id], ['ZCARD', 'lb']]);
      return send(200, { name, rank: w[0] != null ? w[0] + 1 : 0, total: w[1] });
    }
    if (op === 'score' && req.method === 'POST') {
      const nights = int(body.nights, 0, 1000), shot = int(body.shot, 0, 1e7), launched = int(body.launched, 0, 1e7);
      const run = typeof body.run === 'string' ? body.run.slice(0, 40).replace(/[^\w\-]/g, '') : '';
      if (!id || nights == null || shot == null || launched == null || !run) return send(400, { error: 'Неверные данные' });
      if (shot > launched || shot > 120 + nights * nights * 25 + nights * 150) return send(400, { error: 'Неправдоподобный результат' });
      const r = await R([...rl('score'), ['GET', 'run:' + run], ['HGETALL', 'p:' + id]]);
      if (r[0] > 8) return send(429, { error: 'Слишком часто' });
      const now = Date.now(); const cur = obj(r[3]); const has = !!cur.name;
      if (r[2]) { const [pn, pt] = String(r[2]).split('|').map(Number); if (nights > pn + 1 || (nights > pn && now - pt < 15000)) return send(400, { error: 'Неправдоподобный прогресс' }); }
      else if (nights > (has ? +cur.nights : 0) + 1) return send(400, { error: 'Неправдоподобный прогресс' });
      const prevRun = r[2] ? +String(r[2]).split('|')[0] : 0;
      const cmds = [['SET', 'run:' + run, Math.max(nights, prevRun) + '|' + now, 'EX', String(7 * 86400)]];
      let name = has ? cur.name : (cleanName(body.name) || ('Командир-' + id.slice(0, 4)));
      if (!has) { const t = await R([['HGET', 'names', name.toLowerCase()]]); if (t[0] && t[0] !== id) name = name.slice(0, 13) + '-' + id.slice(0, 4); }
      const better = !has || nights > +cur.nights || (nights === +cur.nights && shot > +cur.shot);
      if (better && nights > 0) {
        cmds.push(['HSET', 'p:' + id, 'name', name, 'nights', String(nights), 'shot', String(shot), 'launched', String(launched), 'won', body.won ? '1' : '0', 'at', String(now)]);
        cmds.push(['ZADD', 'lb', String(scoreOf(nights, shot, now)), id]);
        if (!has) cmds.push(['HSETNX', 'names', name.toLowerCase(), id]);
      }
      cmds.push(['ZREVRANK', 'lb', id], ['ZCARD', 'lb'], ...onlineCmds());
      const w = await R(cmds); const n = w.length;
      return send(200, { rank: w[n - 4] != null ? w[n - 4] + 1 : 0, total: w[n - 3], best: better && nights > 0, online: w[n - 1] });
    }
    return send(404, { error: 'Not found' });
  } catch (e) { console.error(e); return send(500, { error: 'Сервер занят, попробуйте позже' }); }
};
