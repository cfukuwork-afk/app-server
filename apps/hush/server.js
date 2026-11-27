// Hush（静かな作業部屋。招待した友だちと机を並べて作業する）— 外部ライブラリなし・Node.js 22
//  - 匿名アカウント（端末ごと）。名前だけで使う
//  - 部屋（机は5つ）・招待コード。作業の開始・休憩・ひとこと（10文字）・終了と記録
//  - みんなの作業時間で部屋が育つ。ブロック・通報・データ削除、机に向かったら通知（Expo のプッシュ）
//  - 招待ページ /j/<code>、利用規約 /terms、プライバシー /privacy、問い合わせ /support、管理画面 /admin
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3105);
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const DB_FILE = path.join(DATA, 'db.json');
const SECRET_FILE = path.join(DATA, 'secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
const ADMIN_FILE = path.join(DATA, 'admin.json');
const CONF_FILE = path.join(__dirname, 'store.json'); // App Store の住所など（公開してよい値だけ）

const COLORS = ['#E58B6B', '#5AA39B', '#C98BB5', '#6C9BD2', '#D9A441', '#8C9A5B', '#7C6BC4', '#D9727F', '#4FA0B8', '#B08455'];

/* ---------- 小さな道具 ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const rid = (n = 9) => crypto.randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const newCode = () => Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const now = () => Date.now();
const chars = (s) => [...String(s ?? '')];
const clip = (s, n) => chars(s).slice(0, n).join('').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim();

const buckets = new Map();
function limited(key, max, windowMs) {
  const t = now();
  const b = buckets.get(key);
  if (!b || t - b.start > windowMs) {
    buckets.set(key, { start: t, n: 1 });
    return false;
  }
  return ++b.n > max;
}
setInterval(() => {
  const t = now();
  for (const [k, b] of buckets) if (t - b.start > 3600e3) buckets.delete(k);
}, 600e3).unref();

async function readBody(req, limit = 64 * 1024) {
  const parts = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw Object.assign(new Error('too large'), { status: 413 });
    parts.push(c);
  }
  return Buffer.concat(parts).toString('utf8');
}
async function readJson(req, limit) {
  const s = await readBody(req, limit);
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const html = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", ...headers });
  res.end(body);
};

/* ---------- 保存（1つのJSONファイル。書き込みはまとめて） ---------- */
let db = { users: {}, rooms: {}, sessions: [], reports: [], messages: [] };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch {}
let dirty = false;
let saving = false;
function touch() {
  dirty = true;
}
async function flush() {
  if (!dirty || saving) return;
  saving = true;
  dirty = false;
  try {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(db));
    await fsp.rename(tmp, DB_FILE);
  } catch (e) {
    dirty = true;
    console.error('save failed', e);
  } finally {
    saving = false;
  }
}
setInterval(flush, 1500).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await flush(); process.exit(0); });


const MAX_MEMBERS = 5; // 机は5つ
const MAX_ROOMS = 10;
const MAX_WORK_MS = 12 * 3600e3; // 終わり忘れは12時間で自動で終える
const STEP_MS = 5 * 3600e3; // 部屋のアイテムは、みんなの作業5時間ごとに1つ増える

/* ---------- アカウント ---------- */
function auth(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) throw fail(401, 'auth');
  const u = db.users[m[1]];
  if (!u || u.banned || u.tokenHash !== hash(m[2])) throw fail(401, 'auth');
  u.seen = now();
  return u;
}
const myRooms = (u) => Object.values(db.rooms).filter((r) => r.members.includes(u.id));
// 作業中の状態（終わり忘れは自動で終える）
function liveOf(u) {
  const l = u.live;
  if (!l) return null;
  const worked = workedMs(l);
  if (worked >= MAX_WORK_MS || now() - l.start > MAX_WORK_MS * 2) {
    finish(u, '', true);
    return null;
  }
  return { what: l.what, start: l.start, pausedMs: l.pausedMs || 0, pausedAt: l.pausedAt || null, say: l.say && now() - l.sayAt < 3 * 3600e3 ? l.say : '' };
}
const workedMs = (l) => Math.max(0, (l.pausedAt || now()) - l.start - (l.pausedMs || 0));
const pub = (u, viewer) => (u ? { id: u.id, name: u.name, color: u.color, live: (viewer?.blocked || []).includes(u.id) ? null : liveOf(u), today: todayMs(u) } : { id: '', name: '?', color: '#999', live: null, today: 0 });
function todayMs(u) {
  const off = (u.tz ?? 540) * 60e3; // 端末の時差（分）。既定は日本
  const day = Math.floor((now() + off) / 86400e3);
  let ms = 0;
  for (let i = db.sessions.length - 1; i >= 0; i--) {
    const s = db.sessions[i];
    if (s.end < now() - 2 * 86400e3) break;
    if (s.uid === u.id && Math.floor((s.start + off) / 86400e3) === day) ms += s.ms;
  }
  if (u.live) ms += workedMs(u.live);
  return ms;
}
function roomOut(r, viewer) {
  const live = r.members.reduce((n, id) => n + (db.users[id]?.live ? workedMs(db.users[id].live) : 0), 0);
  return { id: r.id, name: r.name, code: r.code, owner: r.owner, members: r.members.map((id) => pub(db.users[id], viewer)), totalMs: (r.totalMs || 0) + live, stepMs: STEP_MS, createdAt: r.createdAt };
}
function syncOut(u) {
  return {
    me: { id: u.id, name: u.name, color: u.color, lang: u.lang, live: liveOf(u), today: todayMs(u) },
    rooms: myRooms(u).sort((a, b) => a.createdAt - b.createdAt).map((r) => roomOut(r, u)),
    blocked: (u.blocked || []).map((id) => db.users[id]).filter(Boolean).map((x) => ({ id: x.id, name: x.name, color: x.color })),
    serverTime: now(),
  };
}
function finish(u, msg, auto) {
  const l = u.live;
  if (!l) return null;
  const end = l.pausedAt || Math.min(now(), l.start + MAX_WORK_MS + (l.pausedMs || 0));
  const ms = Math.min(MAX_WORK_MS, workedMs({ ...l, pausedAt: end }));
  u.live = null;
  touch();
  if (ms < 60e3) return null; // 1分未満は記録しない
  const s = { id: rid(8), uid: u.id, what: l.what, start: l.start, end, ms, msg: clip(msg, 40), auto: !!auto };
  db.sessions.push(s);
  for (const r of myRooms(u)) r.totalMs = (r.totalMs || 0) + ms;
  for (const r of myRooms(u)) silent(r, u.id, { t: 'sync' });
  return s;
}
// 古い記録（400日より前）を消す
setInterval(() => {
  const limit = now() - 400 * 86400e3;
  const n = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.end >= limit);
  if (db.sessions.length !== n) touch();
}, 6 * 3600e3).unref();

/* ---------- 通知（Expo のプッシュ） ---------- */
async function push(msgs) {
  for (let i = 0; i < msgs.length; i += 90) {
    try {
      const r = await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(msgs.slice(i, i + 90)), signal: AbortSignal.timeout(10000) });
      const j = await r.json().catch(() => ({}));
      (j.data || []).forEach((t, k) => {
        if (t?.details?.error === 'DeviceNotRegistered') {
          const u = Object.values(db.users).find((x) => x.pushToken === msgs[i + k].to);
          if (u) (u.pushToken = null), touch();
        }
      });
    } catch (e) {
      console.error('push failed', e.message);
    }
  }
}
function notifyStart(u) {
  // 同じ人の「机に向かいました」は30分に1回まで
  if (u.lastStartPush && now() - u.lastStartPush < 30 * 60e3) return;
  u.lastStartPush = now();
  const sent = new Set();
  const msgs = [];
  for (const r of myRooms(u)) {
    for (const id of r.members) {
      if (id === u.id || sent.has(id)) continue;
      const o = db.users[id];
      if (!o?.pushToken || o.notify === false || (o.blocked || []).includes(u.id) || (o.muted || []).includes(r.id)) continue;
      sent.add(id);
      const ja = o.lang === 'ja';
      msgs.push({ to: o.pushToken, title: r.members.length > 2 ? r.name : 'Hush', body: ja ? `${u.name}さんが机に向かいました（${u.live.what}）` : `${u.name} sat down to work (${u.live.what})`, sound: 'default', data: { t: 'start', r: r.id } });
    }
  }
  push(msgs);
}
function silent(r, exceptId, data) {
  bump(r.members.filter((id) => id !== exceptId));
  const msgs = r.members.filter((id) => id !== exceptId).map((id) => db.users[id]).filter((x) => x?.pushToken).map((x) => ({ to: x.pushToken, _contentAvailable: true, priority: 'normal', data }));
  if (msgs.length) push(msgs);
}


/* ---------- すぐ届く更新（ロングポーリング）：アプリを開いている間、変更があれば数秒以内に知らせる ---------- */
// 携帯回線・Wi-Fi どちらでも普通の HTTPS で動く（中継やファイアウォールに強い）。最大 25 秒待って、何もなければ空で返す
const ver = new Map(); // ユーザー → 変更の番号
const waiters = new Map(); // ユーザー → 待っている応答
function bump(ids) {
  for (const id of ids) {
    ver.set(id, (ver.get(id) || 0) + 1);
    const ws = waiters.get(id);
    if (ws) { waiters.delete(id); for (const fn of ws) fn(); }
  }
}
function waitFor(u, since, res) {
  const cur = ver.get(u.id) || 0;
  if (since !== cur) return json(res, 200, { v: cur, changed: since >= 0 && since !== cur });
  let done = false;
  const finish = () => { if (done) return; done = true; clearTimeout(tm); const set = waiters.get(u.id); if (set) set.delete(finish); json(res, 200, { v: ver.get(u.id) || 0, changed: true }); };
  const tm = setTimeout(() => { if (done) return; done = true; const set = waiters.get(u.id); if (set) set.delete(finish); json(res, 200, { v: ver.get(u.id) || 0, changed: false }); }, 25000);
  if (!waiters.has(u.id)) waiters.set(u.id, new Set());
  waiters.get(u.id).add(finish);
  res.on('close', () => { if (!done) { done = true; clearTimeout(tm); const set = waiters.get(u.id); if (set) set.delete(finish); } });
}

/* ---------- API ---------- */
async function api(req, res, p, ip) {
  const method = req.method;
  let mm;
  if (p === '/v1/register' && method === 'POST') {
    if (limited('reg:' + ip, 20, 3600e3)) throw fail(429, 'slow_down');
    const b = await readJson(req);
    const name = clip(b.name, 5);
    if (!name) throw fail(400, 'name');
    const token = rid(24);
    const u = { id: rid(8), tokenHash: hash(token), name, color: COLORS[Math.floor(Math.random() * COLORS.length)], lang: b.lang === 'ja' ? 'ja' : 'en', tz: Number.isFinite(b.tz) ? Math.max(-840, Math.min(840, b.tz)) : 540, pushToken: null, blocked: [], muted: [], live: null, createdAt: now(), seen: now() };
    db.users[u.id] = u;
    touch();
    return json(res, 200, { uid: u.id, token, ...syncOut(u) });
  }

  const u = auth(req);
  if (limited('u:' + u.id, 900, 3600e3)) throw fail(429, 'slow_down');

  if (p === '/v1/sync' && method === 'GET') return json(res, 200, syncOut(u));
  if (p === '/v1/wait' && method === 'GET') return waitFor(u, Number(new URL(req.url, 'http://x').searchParams.get('v') ?? -1), res);

  if (p === '/v1/me' && method === 'PUT') {
    const b = await readJson(req);
    if (b.name != null) {
      const name = clip(b.name, 5);
      if (!name) throw fail(400, 'name');
      u.name = name;
    }
    if (b.color && COLORS.includes(b.color)) u.color = b.color;
    if (b.lang) u.lang = b.lang === 'ja' ? 'ja' : 'en';
    if (Number.isFinite(b.tz)) u.tz = Math.max(-840, Math.min(840, b.tz));
    if (typeof b.notify === 'boolean') u.notify = b.notify;
    if (b.pushToken !== undefined) {
      const t = b.pushToken ? String(b.pushToken).slice(0, 200) : null;
      if (t) for (const o of Object.values(db.users)) if (o.id !== u.id && o.pushToken === t) o.pushToken = null;
      u.pushToken = t;
    }
    touch();
    return json(res, 200, syncOut(u));
  }

  if (p === '/v1/me' && method === 'DELETE') {
    for (const r of myRooms(u)) leaveRoom(r, u);
    db.sessions = db.sessions.filter((s) => s.uid !== u.id);
    for (const o of Object.values(db.users)) if (o.blocked?.includes(u.id)) o.blocked = o.blocked.filter((x) => x !== u.id);
    delete db.users[u.id];
    touch();
    return json(res, 200, { ok: true });
  }

  /* 作業 */
  if (p === '/v1/work/start' && method === 'POST') {
    const b = await readJson(req);
    const what = clip(b.what, 6);
    if (!what) throw fail(400, 'what');
    if (u.live) finish(u, '');
    u.live = { what, start: now(), pausedMs: 0, pausedAt: null, say: '', sayAt: 0 };
    touch();
    notifyStart(u);
    for (const r of myRooms(u)) silent(r, u.id, { t: 'sync' });
    return json(res, 200, syncOut(u));
  }
  if (p === '/v1/work/pause' && method === 'POST') {
    if (u.live && !u.live.pausedAt) (u.live.pausedAt = now()), touch();
    return json(res, 200, syncOut(u));
  }
  if (p === '/v1/work/resume' && method === 'POST') {
    if (u.live?.pausedAt) {
      u.live.pausedMs = (u.live.pausedMs || 0) + (now() - u.live.pausedAt);
      u.live.pausedAt = null;
      touch();
    }
    return json(res, 200, syncOut(u));
  }
  if (p === '/v1/work/say' && method === 'POST') {
    if (limited('say:' + u.id, 60, 3600e3)) throw fail(429, 'slow_down');
    const b = await readJson(req);
    if (!u.live) throw fail(409, 'not_working');
    u.live.say = clip(b.say, 10);
    u.live.sayAt = now();
    touch();
    return json(res, 200, syncOut(u));
  }
  if (p === '/v1/work/stop' && method === 'POST') {
    const b = await readJson(req);
    const s = finish(u, b.msg);
    return json(res, 200, { session: s, ...syncOut(u) });
  }
  if (p === '/v1/history' && method === 'GET') {
    const list = db.sessions.filter((s) => s.uid === u.id).slice(-3000).map((s) => ({ id: s.id, what: s.what, start: s.start, end: s.end, ms: s.ms, msg: s.msg || '' }));
    return json(res, 200, { sessions: list });
  }

  /* 部屋 */
  if (p === '/v1/rooms' && method === 'POST') {
    const b = await readJson(req);
    if (myRooms(u).length >= MAX_ROOMS) throw fail(400, 'too_many');
    const r = { id: rid(8), name: clip(b.name, 12) || (u.lang === 'ja' ? '作業部屋' : 'Study room'), owner: u.id, members: [u.id], code: newCode(), totalMs: 0, createdAt: now() };
    db.rooms[r.id] = r;
    touch();
    return json(res, 200, { room: roomOut(r, u), ...syncOut(u) });
  }
  if (p === '/v1/join' && method === 'POST') {
    if (limited('join:' + u.id, 30, 3600e3)) throw fail(429, 'slow_down');
    const b = await readJson(req);
    const code = String(b.code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const r = Object.values(db.rooms).find((x) => x.code === code);
    if (!r) throw fail(404, 'code');
    if (!r.members.includes(u.id)) {
      if (r.members.length >= MAX_MEMBERS) throw fail(409, 'full');
      if (myRooms(u).length >= MAX_ROOMS) throw fail(400, 'too_many');
      r.members.push(u.id);
      touch();
      silent(r, u.id, { t: 'sync' });
    }
    return json(res, 200, { room: roomOut(r, u), ...syncOut(u) });
  }
  if ((mm = p.match(/^\/v1\/invite\/([a-z0-9]+)$/)) && method === 'GET') {
    const r = Object.values(db.rooms).find((x) => x.code === mm[1]);
    if (!r) throw fail(404, 'code');
    return json(res, 200, { name: r.name, count: r.members.length, full: r.members.length >= MAX_MEMBERS, joined: r.members.includes(u.id) });
  }
  if ((mm = p.match(/^\/v1\/rooms\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/))) {
    const r = db.rooms[mm[1]];
    if (!r || !r.members.includes(u.id)) throw fail(404, 'room');
    const sub = mm[2] || '';
    if (sub === '' && method === 'PATCH') {
      const b = await readJson(req);
      const name = clip(b.name, 12);
      if (!name) throw fail(400, 'name');
      r.name = name;
      touch();
      silent(r, u.id, { t: 'sync' });
      return json(res, 200, syncOut(u));
    }
    if (sub === '/leave' && method === 'POST') {
      leaveRoom(r, u);
      touch();
      return json(res, 200, syncOut(u));
    }
    if (sub === '/mute' && method === 'POST') {
      const b = await readJson(req);
      u.muted = (u.muted || []).filter((x) => x !== r.id);
      if (b.mute) u.muted.push(r.id);
      touch();
      return json(res, 200, { ok: true });
    }
  }

  /* ブロック・通報 */
  if (p === '/v1/block' && method === 'POST') {
    const b = await readJson(req);
    const t = db.users[b.uid];
    if (!t || t.id === u.id) throw fail(404, 'user');
    u.blocked = [...new Set([...(u.blocked || []), t.id])];
    touch();
    return json(res, 200, syncOut(u));
  }
  if ((mm = p.match(/^\/v1\/block\/([A-Za-z0-9_-]+)$/)) && method === 'DELETE') {
    u.blocked = (u.blocked || []).filter((x) => x !== mm[1]);
    touch();
    return json(res, 200, syncOut(u));
  }
  if (p === '/v1/report' && method === 'POST') {
    if (limited('rep:' + u.id, 30, 3600e3)) throw fail(429, 'slow_down');
    const b = await readJson(req);
    const t = db.users[b.uid];
    if (!t) throw fail(404, 'user');
    db.reports.push({ id: rid(8), by: u.id, user: t.id, name: t.name, say: t.live?.say || '', reason: clip(b.reason, 200), at: now(), done: false });
    touch();
    return json(res, 200, { ok: true });
  }
  throw fail(404, 'not_found');
}
function leaveRoom(r, u) {
  r.members = r.members.filter((x) => x !== u.id);
  if (!r.members.length) {
    delete db.rooms[r.id];
    return;
  }
  if (r.owner === u.id) r.owner = r.members[0];
  silent(r, u.id, { t: 'sync' });
}
// 終わり忘れの見回り
setInterval(() => {
  for (const u of Object.values(db.users)) if (u.live) liveOf(u);
}, 10 * 60e3).unref();

/* ---------- ページ ---------- */
const pageLang = (req, q) => (q.get('lang') === 'ja' || (!q.get('lang') && /^ja\b/i.test(String(req.headers['accept-language'] || ''))) ? 'ja' : 'en');
const CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;color:#2A2433;background:#F6EFE6}main{max-width:720px;margin:0 auto;padding:32px 20px 60px}h1{font-size:26px;line-height:1.3;margin:0 0 6px}h2{font-size:18px;margin:28px 0 6px}a{color:#7A5BD0}.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;margin-bottom:24px}.logo img{width:40px;height:40px;border-radius:10px}.card{background:#fff;border-radius:22px;padding:28px 22px;text-align:center;box-shadow:0 6px 24px rgba(42,36,51,.1)}.btn{display:inline-block;margin:8px 4px 0;padding:14px 22px;border-radius:999px;background:#2A2433;color:#fff;text-decoration:none;font-weight:800;border:0;font-size:15px}.btn.sub{background:#EFE7DC;color:#2A2433}.code{font:800 22px ui-monospace,Menlo,monospace;letter-spacing:.12em;background:#F1EAFB;border-radius:12px;padding:8px 14px;display:inline-block;margin:10px 0}.small{font-size:13px;color:#857D90}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #eee;padding:8px;text-align:left;vertical-align:top}`;
const shell = (lang, title, body) => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main><div class="logo"><img src="/icon.png" alt="">Hush</div>${body}</main></body></html>`;
function invitePage(req, q, code) {
  const lang = pageLang(req, q);
  const ja = lang === 'ja';
  const r = Object.values(db.rooms).find((x) => x.code === code);
  if (!r) return shell(lang, 'Hush', `<div class="card"><h1>${ja ? 'この招待は使えません' : 'This invite is no longer valid'}</h1><p>${ja ? '部屋が無くなったか、招待コードが変わりました。招待した人にもう一度送ってもらってください。' : 'The room was removed or the code changed. Ask your friend for a new invite.'}</p></div>`);
  return shell(lang, 'Hush', `<div class="card"><p>${ja ? 'Hush の作業部屋' : 'You’re invited to the study room'}</p><h1>「${esc(r.name)}」${ja ? 'に招待されています' : ''}</h1><p class="small">${ja ? `いま ${r.members.length}人（机は5つ）` : `${r.members.length} of 5 desks taken`}</p>
<a class="btn" href="hush://join/${esc(code)}">${ja ? 'アプリで参加する' : 'Join in the app'}</a><a class="btn sub" href="https://apps.apple.com/search?term=Hush">${ja ? 'アプリを入手する' : 'Get the app'}</a>
<p class="small" style="margin-top:22px">${ja ? 'アプリを入れたあと、この画面に戻って「アプリで参加する」を押すか、アプリで下のコードを入力してください。' : 'After installing, come back and tap “Join in the app”, or enter this code in the app.'}</p><div class="code">${esc(code)}</div></div>`);
}
const TERMS = {
  ja: `<h1>利用規約</h1><p class="small">最終更新：2026年11月27日</p><p>この規約は、Hush（以下「本アプリ」）の利用条件を定めるものです。本アプリを使うことで、この規約に同意したものとみなします。</p>
<h2>1. 本アプリについて</h2><p>本アプリは、招待した人どうしで作業中の様子を共有し、一緒に机に向かうためのアプリです。アカウントは匿名で、名前だけで使えます。</p>
<h2>2. 投稿する内容</h2><p>名前・作業内容・ひとことなど、あなたが入力した内容の責任はあなたにあります。他人の権利を侵すもの、法令に反するもの、暴力的・性的・差別的なもの、嫌がらせ、なりすまし、スパムは投稿できません。不適切な内容や迷惑な利用者は許容しません。</p>
<h2>3. 通報とブロック</h2><p>アプリから利用者を通報・ブロックできます。運営は通報を24時間以内に確認し、規約違反の内容の削除や利用停止を行います。</p>
<h2>4. 禁止事項</h2><p>不正なアクセス、サーバーに過度な負荷をかける行為、他の利用者への迷惑行為を禁止します。</p>
<h2>5. 免責</h2><p>運営は、サービスが途切れないことやデータが失われないことを保証しません。故意または重大な過失による場合を除き、本アプリの利用によって生じた損害について責任を負いません。</p>
<h2>6. 変更</h2><p>この規約は必要に応じて変更することがあります。変更後に本アプリを使った場合、変更に同意したものとみなします。</p>`,
  en: `<h1>Terms of Use</h1><p class="small">Last updated: November 27, 2026</p><p>These terms govern your use of Hush (the “App”). By using the App, you agree to them.</p>
<h2>1. The App</h2><p>Hush lets people you invite see when you are working, so you can sit down to work together. Accounts are anonymous and only need a name.</p>
<h2>2. What you post</h2><p>You are responsible for what you enter (your name, what you are working on, short notes). You may not post anything that infringes others’ rights, breaks the law, is violent, sexual or discriminatory, harasses others, impersonates someone, or is spam. There is no tolerance for objectionable content or abusive users.</p>
<h2>3. Reporting and blocking</h2><p>You can report or block anyone from inside the App. We review reports within 24 hours and remove content or suspend users who break these terms.</p>
<h2>4. Prohibited use</h2><p>No unauthorized access, excessive load on the servers, or harassment of other users.</p>
<h2>5. Disclaimer</h2><p>We do not guarantee uninterrupted service or that data will never be lost, and are not liable for damages arising from use of the App except in cases of intent or gross negligence. Apple’s standard EULA also applies: https://www.apple.com/legal/internet-services/itunes/dev/stdeula/</p>
<h2>6. Changes</h2><p>We may update these terms. Using the App after a change means you accept it.</p>`,
};
const PRIVACY = {
  ja: `<h1>プライバシーポリシー</h1><p class="small">最終更新：2026年11月27日</p>
<h2>扱う情報</h2><p>・あなたが決めた名前と色、言語、時差<br>・作業の記録（作業内容、始めた時刻と終えた時刻、ひとこと、終えたときの一言）<br>・参加している部屋、ブロックした人、送った通報<br>・通知を送るための端末のトークン</p><p>電話番号・メールアドレス・連絡先・位置情報・広告IDは集めません。アカウントは匿名で、端末ごとに作られます。</p>
<h2>使い道</h2><p>部屋の人に作業中の様子を表示すること、記録を見せること、通知を送ること、不正な利用への対応にだけ使います。広告や販売には使いません。</p>
<h2>共有</h2><p>作業中の様子と名前は、同じ部屋の人に表示されます。それ以外の第三者には渡しません。</p>
<h2>使っているサービス</h2><p>通知の送信に Expo（Expo Push Service）と Apple（APNs）、データの保存に借りているサーバー（ConoHa）を使います。</p>
<h2>保存期間と削除</h2><p>作業の記録は最長400日で自動的に消えます。アプリの「設定」→「データをすべて削除」から、いつでもアカウントと記録をすべて削除できます。</p>
<h2>お問い合わせ</h2><p><a href="/support?lang=ja">お問い合わせフォーム</a></p>`,
  en: `<h1>Privacy Policy</h1><p class="small">Last updated: November 27, 2026</p>
<h2>What we handle</h2><p>• The display name, color, language and time zone you choose<br>• Your work sessions (what you work on, start and end times, short notes)<br>• The rooms you are in, people you block, and reports you send<br>• Your device’s push notification token</p><p>We do not collect phone numbers, email addresses, contacts, location or advertising IDs. Accounts are anonymous and tied to your device.</p>
<h2>How we use it</h2><p>Only to show your status to people in your rooms, show your history, send notifications, and deal with abuse. Never for advertising or sale.</p>
<h2>Sharing</h2><p>Your name and status are shown to people in the same room. We do not share it with anyone else.</p>
<h2>Services we use</h2><p>Expo (Expo Push Service) and Apple (APNs) to send notifications, and a rented server (ConoHa) to store data.</p>
<h2>Retention and deletion</h2><p>Work sessions are deleted automatically after at most 400 days. You can delete your account and all your data at any time from Settings → Delete all my data in the App.</p>
<h2>Contact</h2><p><a href="/support?lang=en">Contact form</a></p>`,
};

/* ---------- 管理画面（通報の確認） ---------- */
function isAdmin(req) {
  const c = (String(req.headers.cookie || '').match(/(?:^|;\s*)hs_admin=([^;]+)/) || [])[1];
  if (!c) return false;
  const [exp, sig] = c.split('.');
  return Number(exp) > now() && sig === sign('admin.' + exp);
}
function adminLogin(msg, first) {
  return shell('ja', '管理', `<h1>Hush 管理</h1><p>${esc(msg)}</p><form method="post" action="/admin/login"><input type="password" name="pw" minlength="10" required autocomplete="${first ? 'new-password' : 'current-password'}" style="font-size:16px;padding:10px;border-radius:10px;border:1px solid #ddd"> <button class="btn">${first ? '決める' : 'ログイン'}</button></form>`);
}
function adminPage() {
  const rows = db.reports.slice().reverse().slice(0, 200).map((r) => {
    const who = db.users[r.user];
    return `<tr><td>${new Date(r.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}<br>${r.done ? '対応済み' : '<b>未対応</b>'}</td><td>${esc(r.name)}${who?.banned ? '（停止中）' : ''}<br><span class="small">${esc(r.user)}</span></td><td>${esc(r.say || '-')}<br><span class="small">理由：${esc(r.reason || '-')}</span></td><td><form method="post" action="/admin/act"><input type="hidden" name="id" value="${esc(r.id)}">${who && !who.banned ? '<button class="btn sub" name="a" value="ban">利用停止</button>' : ''}${!r.done ? '<button class="btn sub" name="a" value="done">対応済みにする</button>' : ''}</form></td></tr>`;
  });
  const msgs = (db.messages || []).slice().reverse().slice(0, 50).map((x) => `<tr><td>${new Date(x.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</td><td style="white-space:pre-wrap">${esc(x.msg)}</td></tr>`).join('');
  return shell('ja', '管理', `<h2>お問い合わせ</h2><table>${msgs || '<tr><td>ありません</td></tr>'}</table><h1>通報</h1><p class="small">利用者 ${Object.keys(db.users).length}人・部屋 ${Object.keys(db.rooms).length}・記録 ${db.sessions.length}件</p><table><tr><th>日時</th><th>相手</th><th>内容</th><th></th></tr>${rows.join('') || '<tr><td colspan="4">通報はありません</td></tr>'}</table>`);
}

/* ---------- サーバー ---------- */
const ICON = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'public', 'icon.png'));
  } catch {
    return null;
  }
})();
const server = http.createServer(async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/v1/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      return await api(req, res, p, ip);
    }
    if (p === '/health') return json(res, 200, { ok: true });
    if (p === '/icon.png' && ICON) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(ICON);
    }
    let mm;
    if ((mm = p.match(/^\/j\/([a-z0-9]{4,16})$/))) return html(res, 200, invitePage(req, url.searchParams, mm[1]));
    if (p === '/terms' || p === '/privacy') {
      const lang = pageLang(req, url.searchParams);
      const body = (p === '/terms' ? TERMS : PRIVACY)[lang];
      return html(res, 200, shell(lang, p === '/terms' ? (lang === 'ja' ? '利用規約' : 'Terms of Use') : lang === 'ja' ? 'プライバシーポリシー' : 'Privacy Policy', body + `<p class="small" style="margin-top:30px"><a href="?lang=${lang === 'ja' ? 'en' : 'ja'}">${lang === 'ja' ? 'English' : '日本語'}</a></p>`));
    }
    if ((p === '/' || p === '/support') && req.method !== 'POST') {
      const lang = pageLang(req, url.searchParams);
      const ja = lang === 'ja';
      return html(res, 200, shell(lang, 'Hush', `<h1>${ja ? '友だちと、静かに机を並べる。' : 'Sit down to work, quietly, together.'}</h1><p>${ja ? 'Hush は、招待した友だちと作業部屋を共有するアプリです。誰かが机に向かうと部屋の明かりがつき、みんなの作業時間で部屋が少しずつ育っていきます。' : 'Hush is a shared study room for you and a few friends. When someone sits down to work, their desk lights up, and the room slowly grows with everyone’s hours.'}</p><h2>${ja ? 'お問い合わせ' : 'Contact'}</h2>${url.searchParams.get('sent') ? `<p><b>${ja ? '送信しました。ありがとうございます。' : 'Sent. Thank you!'}</b></p>` : ''}<form method="post" action="/support?lang=${lang}"><p><textarea name="msg" required maxlength="2000" rows="6" style="width:100%;font:inherit;padding:10px;border-radius:12px;border:1px solid #e3d9cd" placeholder="${ja ? '内容（返信が必要な場合は連絡先も書いてください）' : 'Your message (include a way to reach you if you need a reply)'}"></textarea></p><button class="btn">${ja ? '送信する' : 'Send'}</button></form><p><a href="/terms?lang=${lang}">${ja ? '利用規約' : 'Terms of Use'}</a> ・ <a href="/privacy?lang=${lang}">${ja ? 'プライバシーポリシー' : 'Privacy Policy'}</a></p>`));
    }
    if (p === '/support' && req.method === 'POST') {
      if (limited('sup:' + ip, 10, 3600e3)) return json(res, 429, { error: 'slow_down' });
      const msg = clip(new URLSearchParams(await readBody(req, 16 * 1024)).get('msg'), 2000);
      if (msg) {
        db.messages = db.messages || [];
        db.messages.push({ at: now(), msg });
        touch();
      }
      res.writeHead(303, { Location: '/support?sent=1&lang=' + pageLang(req, url.searchParams) });
      return res.end();
    }
    if (p === '/admin') {
      if (!isAdmin(req)) return html(res, 200, adminLogin(fs.existsSync(ADMIN_FILE) ? 'パスワードを入力してください。' : '初めて開きました。管理用のパスワード（10文字以上）を決めてください。', !fs.existsSync(ADMIN_FILE)));
      return html(res, 200, adminPage());
    }
    if (p === '/admin/login' && req.method === 'POST') {
      if (limited('login:' + ip, 10, 600e3)) return html(res, 429, adminLogin('しばらく待ってからお試しください。', false));
      const pw = new URLSearchParams(await readBody(req)).get('pw') || '';
      if (!fs.existsSync(ADMIN_FILE)) {
        if (pw.length < 10) return html(res, 200, adminLogin('10文字以上で決めてください。', true));
        const salt = rid(12);
        fs.writeFileSync(ADMIN_FILE, JSON.stringify({ salt, h: crypto.scryptSync(pw, salt, 32).toString('hex') }), { mode: 0o600 });
      } else {
        const a = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
        if (!crypto.timingSafeEqual(Buffer.from(a.h, 'hex'), crypto.scryptSync(pw, a.salt, 32))) return html(res, 200, adminLogin('パスワードが違います。', false));
      }
      const exp = now() + 7 * 86400e3;
      res.writeHead(303, { Location: '/admin', 'Set-Cookie': `hs_admin=${exp}.${sign('admin.' + exp)}; Path=/; Max-Age=${7 * 86400}; HttpOnly; Secure; SameSite=Strict` });
      return res.end();
    }
    if (p === '/admin/act' && req.method === 'POST') {
      if (!isAdmin(req)) return html(res, 403, adminLogin('ログインしてください。', false));
      const f = new URLSearchParams(await readBody(req));
      const r = db.reports.find((x) => x.id === f.get('id'));
      if (r) {
        const a = f.get('a');
        if (a === 'ban' && db.users[r.user]) {
          const t = db.users[r.user];
          t.banned = true;
          t.live = null;
          for (const g of myRooms(t)) leaveRoom(g, t);
          r.done = true;
        }
        if (a === 'done') r.done = true;
        touch();
      }
      res.writeHead(303, { Location: '/admin' });
      return res.end();
    }
    return json(res, 404, { error: 'not_found' });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: e.code || (status === 500 ? 'server' : e.message) });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log('hush on', PORT));
