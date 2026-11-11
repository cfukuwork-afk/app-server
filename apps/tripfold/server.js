// Tripfold 共有サーバー（外部ライブラリなし・Node.js 22）
//  - 共有コードで旅行を2人以上で編集（項目ごとに新しい方を採用してまとめる）
//  - 写真の保存と配信
//  - 場所探しの結果をみんなで使い回す
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3101);
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const TRIPS = path.join(DATA, 'trips');
const PHOTOS = path.join(DATA, 'photos');
const GEO_FILE = path.join(DATA, 'geo.json');
for (const d of [DATA, TRIPS, PHOTOS]) fs.mkdirSync(d, { recursive: true });
setTimeout(() => {}, 0);

const MAX_JSON = 2 * 1024 * 1024;
const MAX_PHOTO = 15 * 1024 * 1024;
const MAX_PHOTOS_PER_TRIP = 500;
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
const COLLECTIONS = ['bookings', 'expenses', 'checklist', 'members', 'wishes'];
const META = ['name', 'emoji', 'cover', 'budget'];

/* ---------- 小さな道具 ---------- */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const now = () => Date.now();
const newCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
const normCode = (c) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const tripFile = (code) => path.join(TRIPS, `${code}.json`);

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...headers });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

// 同じ旅行への書き込みは順番に
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

/* ---------- 回数制限（いたずら・総当たり対策） ---------- */
const buckets = new Map();
function limited(ip, kind, max, windowMs) {
  const key = `${kind}:${ip}`;
  const t = now();
  const b = buckets.get(key);
  if (!b || t - b.start > windowMs) {
    buckets.set(key, { start: t, n: 1 });
    return false;
  }
  b.n += 1;
  return b.n > max;
}
setInterval(() => {
  const t = now();
  for (const [k, b] of buckets) if (t - b.start > 15 * 60 * 1000) buckets.delete(k);
}, 60 * 1000).unref();

/* ---------- 旅行のまとめ方（項目ごとに新しい方を採用） ---------- */
function clean(trip) {
  const t = { ...(trip || {}) };
  delete t.share;
  delete t.myId;
  return t;
}
function mergeTrip(server, incoming) {
  if (!server) return clean(incoming);
  const a = clean(server);
  const b = clean(incoming);
  const out = { ...a };
  // 消した記録（どちらかで消したものは消す。ただし消した後に直されたものは残す）
  const tomb = { ...(a.tomb || {}) };
  for (const [id, at] of Object.entries(b.tomb || {})) tomb[id] = Math.max(tomb[id] || 0, Number(at) || 0);
  out.tomb = tomb;
  for (const key of COLLECTIONS) {
    const map = new Map();
    const order = [];
    const put = (item) => {
      if (!item || typeof item !== 'object' || !item.id) return;
      const cur = map.get(item.id);
      if (!cur) {
        map.set(item.id, item);
        order.push(item.id);
      } else if ((Number(item.u) || 0) >= (Number(cur.u) || 0)) map.set(item.id, item);
    };
    (a[key] || []).forEach(put);
    // 送られてきた方の並び順を優先
    const incomingIds = (b[key] || []).map((x) => x && x.id).filter(Boolean);
    (b[key] || []).forEach(put);
    const rest = order.filter((id) => !incomingIds.includes(id));
    const ids = [...incomingIds.filter((id, i) => incomingIds.indexOf(id) === i), ...rest];
    out[key] = ids
      .map((id) => map.get(id))
      .filter((x) => x && !(tomb[x.id] && tomb[x.id] >= (Number(x.u) || 0)));
  }
  // 思い出（日付ごと）
  const j = { ...(a.journal || {}) };
  for (const [d, v] of Object.entries(b.journal || {})) {
    if (!j[d] || (Number(v && v.u) || 0) >= (Number(j[d].u) || 0)) j[d] = v;
  }
  out.journal = j;
  // 名前・表紙・予算など
  if ((Number(b.metaU) || 0) >= (Number(a.metaU) || 0)) {
    for (const k of META) out[k] = b[k];
    out.metaU = b.metaU;
  }
  out.id = a.id || b.id;
  out.createdAt = a.createdAt || b.createdAt;
  return out;
}

async function loadDoc(code) {
  try {
    return JSON.parse(await fsp.readFile(tripFile(code), 'utf8'));
  } catch {
    return null;
  }
}

/* ---------- 場所探しの使い回し ---------- */
let geo = {};
try {
  geo = JSON.parse(fs.readFileSync(GEO_FILE, 'utf8'));
} catch {}
let geoTimer = null;
function saveGeoSoon() {
  if (geoTimer) return;
  geoTimer = setTimeout(() => {
    geoTimer = null;
    writeAtomic(GEO_FILE, JSON.stringify(geo)).catch(() => {});
  }, 5000);
}
const geoKey = (q) => String(q || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);

/* ---------- 写真 ---------- */
function photoType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(4, 12).toString('latin1').match(/^ftyp(heic|heix|mif1|msf1|avif)/)) return 'heic';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
const MIME = { jpg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp' };

/* ---------- 受付 ---------- */
const server = http.createServer(async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'OPTIONS') return send(res, 204, undefined);
    if (limited(ip, 'all', 300, 60 * 1000)) return send(res, 429, { error: 'too many requests' });

    if (p === '/' || p === '/health') return send(res, 200, { ok: true, app: 'tripfold', time: new Date().toISOString() });

    // 共有を始める
    if (req.method === 'POST' && p === '/v1/share') {
      if (limited(ip, 'share', 30, 60 * 60 * 1000)) return send(res, 429, { error: 'too many shares' });
      const body = await readJson(req);
      if (!body.trip || typeof body.trip !== 'object') return send(res, 400, { error: 'trip required' });
      let code = newCode();
      while (fs.existsSync(tripFile(code))) code = newCode();
      const doc = { trip: mergeTrip(null, body.trip), rev: 1, createdAt: now(), updatedAt: now() };
      await writeAtomic(tripFile(code), JSON.stringify(doc));
      return send(res, 200, { code, rev: doc.rev, trip: doc.trip });
    }

    // 旅行の取得・更新
    let m = p.match(/^\/v1\/trips\/([^/]+)$/);
    if (m) {
      const code = normCode(m[1]);
      if (!CODE_RE.test(code)) return send(res, 400, { error: 'bad code' });
      if (req.method === 'GET') {
        const doc = await loadDoc(code);
        if (!doc) {
          if (limited(ip, 'miss', 30, 10 * 60 * 1000)) return send(res, 429, { error: 'too many tries' });
          return send(res, 404, { error: 'not found' });
        }
        const since = Number(url.searchParams.get('rev') || 0);
        if (since && since === doc.rev) return send(res, 200, { unchanged: true, rev: doc.rev });
        return send(res, 200, { rev: doc.rev, trip: doc.trip, updatedAt: doc.updatedAt });
      }
      if (req.method === 'PUT') {
        const body = await readJson(req);
        if (!body.trip || typeof body.trip !== 'object') return send(res, 400, { error: 'trip required' });
        return await withLock(code, async () => {
          const doc = await loadDoc(code);
          if (!doc) return send(res, 404, { error: 'not found' });
          const merged = mergeTrip(doc.trip, body.trip);
          const changed = JSON.stringify(merged) !== JSON.stringify(doc.trip);
          if (changed) {
            doc.trip = merged;
            doc.rev += 1;
            doc.updatedAt = now();
            await writeAtomic(tripFile(code), JSON.stringify(doc));
          }
          return send(res, 200, { rev: doc.rev, trip: doc.trip });
        });
      }
      if (req.method === 'DELETE') {
        // 共有をやめる（データと写真を消す）
        await withLock(code, async () => {
          await fsp.rm(tripFile(code), { force: true });
          await fsp.rm(path.join(PHOTOS, code), { recursive: true, force: true });
        });
        return send(res, 200, { ok: true });
      }
    }

    // 写真を送る
    m = p.match(/^\/v1\/trips\/([^/]+)\/photos$/);
    if (m && req.method === 'POST') {
      const code = normCode(m[1]);
      if (!CODE_RE.test(code) || !fs.existsSync(tripFile(code))) return send(res, 404, { error: 'not found' });
      if (limited(ip, 'photo', 200, 60 * 60 * 1000)) return send(res, 429, { error: 'too many photos' });
      const buf = await readBody(req, MAX_PHOTO);
      const ext = photoType(buf);
      if (!ext) return send(res, 415, { error: 'unsupported image' });
      const dir = path.join(PHOTOS, code);
      await fsp.mkdir(dir, { recursive: true });
      if ((await fsp.readdir(dir)).length >= MAX_PHOTOS_PER_TRIP) return send(res, 507, { error: 'photo limit' });
      const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
      const name = `${hash}.${ext}`;
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) await writeAtomic(file, buf);
      return send(res, 200, { path: `/v1/p/${code}/${name}` });
    }

    // 写真を見る
    m = p.match(/^\/v1\/p\/([^/]+)\/([a-f0-9]{24}\.(jpg|png|heic|webp))$/);
    if (m && req.method === 'GET') {
      const code = normCode(m[1]);
      if (!CODE_RE.test(code)) return send(res, 404, { error: 'not found' });
      const file = path.join(PHOTOS, code, m[2]);
      try {
        const st = await fsp.stat(file);
        res.writeHead(200, { 'Content-Type': MIME[m[3]], 'Content-Length': st.size, 'Cache-Control': 'public, max-age=31536000, immutable', ...CORS });
        fs.createReadStream(file).pipe(res);
      } catch {
        send(res, 404, { error: 'not found' });
      }
      return;
    }

    // 場所探しの使い回し
    if (p === '/v1/geo') {
      if (req.method === 'GET') {
        const hit = geo[geoKey(url.searchParams.get('q'))];
        return hit ? send(res, 200, hit) : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'POST') {
        if (limited(ip, 'geo', 300, 60 * 60 * 1000)) return send(res, 429, { error: 'too many' });
        const b = await readJson(req);
        const k = geoKey(b.q);
        const lat = Number(b.lat);
        const lng = Number(b.lng);
        if (!k || !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return send(res, 400, { error: 'bad' });
        const tz = typeof b.tz === 'string' && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(b.tz) ? b.tz : undefined;
        if (Object.keys(geo).length < 300000) {
          geo[k] = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, ...(tz ? { tz } : geo[k]?.tz ? { tz: geo[k].tz } : {}) };
          saveGeoSoon();
        }
        return send(res, 200, { ok: true });
      }
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
    if (!e.status) console.error(e);
  }
});

if (require.main === module) server.listen(PORT, '127.0.0.1', () => console.log(`tripfold listening on ${PORT}`));
module.exports = { mergeTrip };
