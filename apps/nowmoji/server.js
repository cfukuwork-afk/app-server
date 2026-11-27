// Nowmoji（親しい人のロック画面に、いまの気分を顔文字で置いておく）— 外部ライブラリなし・Node.js 22
//  - 匿名アカウント（端末ごと）。名前だけ決めて使う
//  - グループ（自分を入れて5人まで）・招待コード・名前の変更・退出
//  - 投稿（顔文字・キャラの絵・落書き・画像スタンプ＋ひとこと）。ウィジェットは各人の最新だけ、履歴はカレンダーで
//  - ブロック・通報・データ削除、届いたら通知（Expo のプッシュ）
//  - 招待ページ /j/<code>、利用規約 /terms、プライバシー /privacy、管理画面 /admin（最初に開いた人がパスワードを決める）
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3103);
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const IMG = path.join(DATA, 'img');
fs.mkdirSync(IMG, { recursive: true });
const DB_FILE = path.join(DATA, 'db.json');
const SECRET_FILE = path.join(DATA, 'secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
const ADMIN_FILE = path.join(DATA, 'admin.json');
const CONF_FILE = path.join(__dirname, 'store.json'); // App Store の住所など（公開してよい値だけ）

const MAX_MEMBERS = 5; // 自分を入れて5人
const FREE_GROUPS = 2;
const MOODS = {
  sleepy: { ja: 'ねむい', en: 'Sleepy', kao: '(´-ω-`)zz' },
  miss: { ja: '会いたい', en: 'Miss you', kao: '(っ´ω`c)♡' },
  work: { ja: 'がんばり中', en: 'Busy', kao: '(ง`ω´)ง' },
  eat: { ja: 'ごはん中', en: 'Eating', kao: '(*´ч`*)' },
  move: { ja: '移動中', en: 'On my way', kao: 'ε=┌(・_・)┘' },
  free: { ja: 'ひま', en: 'Bored', kao: '(´ー`)' },
  down: { ja: 'しょんぼり', en: 'Down', kao: '(´・ω・`)' },
  happy: { ja: 'うれしい', en: 'Happy', kao: '(*´▽`*)' },
};
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
let db = { users: {}, groups: {}, posts: [], reports: [] };
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

// 投稿は新しい順に検索することが多いので、グループごとの索引を持つ
const byGroup = new Map();
function indexPost(p) {
  if (!byGroup.has(p.g)) byGroup.set(p.g, []);
  byGroup.get(p.g).push(p);
}
for (const p of db.posts) indexPost(p);

// 古い投稿（400日より前）を消す
async function prune() {
  const limit = now() - 400 * 86400e3;
  const keep = [];
  for (const p of db.posts) {
    if (p.at >= limit) keep.push(p);
    else if (p.img) await fsp.rm(path.join(IMG, p.img), { force: true });
  }
  if (keep.length !== db.posts.length) {
    db.posts = keep;
    byGroup.clear();
    for (const p of keep) indexPost(p);
    touch();
  }
}
setInterval(() => prune().catch(() => {}), 6 * 3600e3).unref();

/* ---------- アカウント ---------- */
function auth(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) throw fail(401, 'auth');
  const u = db.users[m[1]];
  if (!u || u.banned || u.tokenHash !== hash(m[2])) throw fail(401, 'auth');
  u.seen = now();
  return u;
}
const pub = (u) => (u ? { id: u.id, name: u.name, color: u.color } : { id: '', name: '?', color: '#999' });
const myGroups = (u) => Object.values(db.groups).filter((g) => g.members.includes(u.id));
function latestOf(g, viewer) {
  const list = byGroup.get(g.id) || [];
  const out = {};
  const blocked = new Set(viewer.blocked || []);
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (out[p.from] || blocked.has(p.from) || !g.members.includes(p.from)) continue;
    out[p.from] = postOut(p);
    if (Object.keys(out).length >= g.members.length) break;
  }
  return out;
}
const postOut = (p) => ({ id: p.id, g: p.g, from: p.from, kind: p.kind, mood: p.mood || null, kao: p.kao || null, word: p.word || '', img: p.img ? '/img/' + p.img : null, at: p.at });
function groupOut(g, viewer) {
  return { id: g.id, name: g.name, code: g.code, owner: g.owner, members: g.members.map((id) => pub(db.users[id])), latest: latestOf(g, viewer), createdAt: g.createdAt };
}
function syncOut(u) {
  return {
    me: { id: u.id, name: u.name, color: u.color, lang: u.lang, plus: !!u.plus },
    groups: myGroups(u).sort((a, b) => a.createdAt - b.createdAt).map((g) => groupOut(g, u)),
    blocked: (u.blocked || []).map((id) => pub(db.users[id])).filter((x) => x.id),
    serverTime: now(),
  };
}

/* ---------- 通知（Expo のプッシュ） ---------- */
function moodText(p, lang) {
  const l = lang === 'ja' ? 'ja' : 'en';
  if (p.kind === 'kao') return p.kao || (p.mood && MOODS[p.mood]?.kao) || '';
  if (p.kind === 'art') return (MOODS[p.mood]?.kao || '') + ' ' + (MOODS[p.mood]?.[l] || '');
  if (p.kind === 'doodle') return l === 'ja' ? '落書きが届きました' : 'Sent a doodle';
  if (p.kind === 'stamp') return l === 'ja' ? 'イラストが届きました' : 'Sent a picture';
  return '';
}
async function notify(p, g, from) {
  const msgs = [];
  for (const id of g.members) {
    if (id === from.id) continue;
    const u = db.users[id];
    if (!u || !u.pushToken || (u.blocked || []).includes(from.id) || (u.muted || []).includes(g.id)) continue;
    const body = [moodText(p, u.lang), p.word].filter(Boolean).join('  ');
    msgs.push({ to: u.pushToken, title: from.name, subtitle: g.members.length > 2 ? g.name : undefined, body, sound: 'default', _contentAvailable: true, priority: 'high', data: { t: 'post', g: g.id, from: from.id } });
  }
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
// 名前の変更・参加など、ウィジェットの中身を書き換えたいときの静かな通知
async function silent(g, exceptId, data) {
  const msgs = g.members.filter((id) => id !== exceptId).map((id) => db.users[id]).filter((u) => u?.pushToken).map((u) => ({ to: u.pushToken, _contentAvailable: true, priority: 'normal', data }));
  if (!msgs.length) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msgs), signal: AbortSignal.timeout(10000) });
  } catch {}
}

/* ---------- 画像（PNG / JPEG だけ。中身を見て判定） ---------- */
async function saveImage(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (buf.length < 100 || buf.length > 600 * 1024) throw fail(413, 'image_size');
  let ext = '';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
  else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
  else throw fail(415, 'image_type');
  const name = rid(12) + '.' + ext;
  await fsp.writeFile(path.join(IMG, name), buf);
  return name;
}

/* ---------- API ---------- */
async function api(req, res, p, ip) {
  const m = (re) => p.match(re);
  const method = req.method;

  if (p === '/v1/register' && method === 'POST') {
    if (limited('reg:' + ip, 20, 3600e3)) throw fail(429, 'slow_down');
    const b = await readJson(req);
    const name = clip(b.name, 12);
    if (!name) throw fail(400, 'name');
    const token = rid(24);
    const u = { id: rid(8), tokenHash: hash(token), name, color: COLORS[Math.floor(Math.random() * COLORS.length)], lang: b.lang === 'ja' ? 'ja' : 'en', pushToken: null, blocked: [], muted: [], plus: false, createdAt: now(), seen: now() };
    db.users[u.id] = u;
    touch();
    return json(res, 200, { uid: u.id, token, ...syncOut(u) });
  }

  const u = auth(req);
  if (limited('u:' + u.id, 600, 3600e3)) throw fail(429, 'slow_down');

  if (p === '/v1/sync' && method === 'GET') return json(res, 200, syncOut(u));

  if (p === '/v1/me' && method === 'PUT') {
    const b = await readJson(req);
    if (b.name != null) {
      const name = clip(b.name, 12);
      if (!name) throw fail(400, 'name');
      u.name = name;
      for (const g of myGroups(u)) silent(g, u.id, { t: 'sync' });
    }
    if (b.color && COLORS.includes(b.color)) u.color = b.color;
    if (b.lang) u.lang = b.lang === 'ja' ? 'ja' : 'en';
    if (b.pushToken !== undefined) {
      const t = b.pushToken ? String(b.pushToken).slice(0, 200) : null;
      if (t) for (const o of Object.values(db.users)) if (o.id !== u.id && o.pushToken === t) o.pushToken = null; // 同じ端末で作り直したとき
      u.pushToken = t;
    }
    if (typeof b.plus === 'boolean') u.plus = b.plus;
    touch();
    return json(res, 200, syncOut(u));
  }

  if (p === '/v1/me' && method === 'DELETE') {
    for (const g of myGroups(u)) leaveGroup(g, u);
    const mine = db.posts.filter((x) => x.from === u.id);
    for (const x of mine) if (x.img) await fsp.rm(path.join(IMG, x.img), { force: true });
    db.posts = db.posts.filter((x) => x.from !== u.id);
    byGroup.clear();
    for (const x of db.posts) indexPost(x);
    for (const o of Object.values(db.users)) if (o.blocked?.includes(u.id)) o.blocked = o.blocked.filter((x) => x !== u.id);
    delete db.users[u.id];
    touch();
    return json(res, 200, { ok: true });
  }

  if (p === '/v1/groups' && method === 'POST') {
    const b = await readJson(req);
    if (myGroups(u).length >= FREE_GROUPS && !u.plus) throw fail(402, 'plus');
    if (myGroups(u).length >= 30) throw fail(400, 'too_many');
    const g = { id: rid(8), name: clip(b.name, 12) || (u.lang === 'ja' ? 'グループ' : 'Group'), owner: u.id, members: [u.id], code: newCode(), createdAt: now() };
    db.groups[g.id] = g;
    touch();
    return json(res, 200, { group: groupOut(g, u), ...syncOut(u) });
  }

  if (p === '/v1/join' && method === 'POST') {
    if (limited('join:' + u.id, 30, 3600e3)) throw fail(429, 'slow_down');
    const b = await readJson(req);
    const code = String(b.code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const g = Object.values(db.groups).find((x) => x.code === code);
    if (!g) throw fail(404, 'code');
    if (!g.members.includes(u.id)) {
      if (g.members.length >= MAX_MEMBERS) throw fail(409, 'full');
      if (myGroups(u).length >= FREE_GROUPS && !u.plus) throw fail(402, 'plus');
      g.members.push(u.id);
      touch();
      silent(g, u.id, { t: 'sync' });
    }
    return json(res, 200, { group: groupOut(g, u), ...syncOut(u) });
  }

  let mm;
  if ((mm = m(/^\/v1\/invite\/([a-z0-9]+)$/)) && method === 'GET') {
    const g = Object.values(db.groups).find((x) => x.code === mm[1]);
    if (!g) throw fail(404, 'code');
    return json(res, 200, { name: g.name, count: g.members.length, full: g.members.length >= MAX_MEMBERS, joined: g.members.includes(u.id) });
  }

  if ((mm = m(/^\/v1\/groups\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/))) {
    const g = db.groups[mm[1]];
    if (!g || !g.members.includes(u.id)) throw fail(404, 'group');
    const sub = mm[2] || '';
    if (sub === '' && method === 'PATCH') {
      const b = await readJson(req);
      const name = clip(b.name, 12);
      if (!name) throw fail(400, 'name');
      g.name = name;
      touch();
      silent(g, u.id, { t: 'sync' });
      return json(res, 200, syncOut(u));
    }
    if (sub === '/leave' && method === 'POST') {
      leaveGroup(g, u);
      touch();
      return json(res, 200, syncOut(u));
    }
    if (sub === '/mute' && method === 'POST') {
      const b = await readJson(req);
      u.muted = (u.muted || []).filter((x) => x !== g.id);
      if (b.mute) u.muted.push(g.id);
      touch();
      return json(res, 200, { ok: true });
    }
    if (sub === '/posts' && method === 'POST') {
      if (limited('post:' + u.id, 120, 3600e3)) throw fail(429, 'slow_down');
      const b = await readJson(req, 900 * 1024);
      const kind = ['kao', 'art', 'doodle', 'stamp'].includes(b.kind) ? b.kind : null;
      if (!kind) throw fail(400, 'kind');
      const post = { id: rid(9), g: g.id, from: u.id, kind, at: now() };
      if (kind === 'kao' || kind === 'art') {
        if (b.mood && MOODS[b.mood]) post.mood = b.mood;
        if (kind === 'kao') post.kao = clip(b.kao, 14) || (post.mood ? MOODS[post.mood].kao : '');
        if (kind === 'kao' && !post.kao) throw fail(400, 'kao');
        if (kind === 'art' && !post.mood) throw fail(400, 'mood');
      } else {
        post.img = await saveImage(b.image);
      }
      const word = clip(b.word, 20);
      if (word) post.word = word;
      db.posts.push(post);
      indexPost(post);
      touch();
      notify(post, g, u);
      return json(res, 200, { post: postOut(post), ...syncOut(u) });
    }
    if (sub === '/history' && method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams;
      const from = Number(q.get('from')) || 0;
      const to = Number(q.get('to')) || now() + 1;
      const blocked = new Set(u.blocked || []);
      const list = (byGroup.get(g.id) || []).filter((x) => x.at >= from && x.at < to && !blocked.has(x.from)).slice(-500).map(postOut);
      const days = {};
      for (const x of byGroup.get(g.id) || []) if (!blocked.has(x.from)) days[new Date(x.at).toISOString().slice(0, 10)] = 1;
      return json(res, 200, { posts: list, days: Object.keys(days), users: Object.fromEntries([...new Set(list.map((x) => x.from))].map((id) => [id, pub(db.users[id])])) });
    }
  }

  if (p === '/v1/block' && method === 'POST') {
    const b = await readJson(req);
    const t = db.users[b.uid];
    if (!t || t.id === u.id) throw fail(404, 'user');
    u.blocked = [...new Set([...(u.blocked || []), t.id])];
    touch();
    return json(res, 200, syncOut(u));
  }
  if ((mm = m(/^\/v1\/block\/([A-Za-z0-9_-]+)$/)) && method === 'DELETE') {
    u.blocked = (u.blocked || []).filter((x) => x !== mm[1]);
    touch();
    return json(res, 200, syncOut(u));
  }
  if (p === '/v1/report' && method === 'POST') {
    if (limited('rep:' + u.id, 30, 3600e3)) throw fail(429, 'slow_down');
    const b = await readJson(req);
    const post = b.post ? db.posts.find((x) => x.id === b.post) : null;
    const target = post ? post.from : b.uid;
    if (!db.users[target]) throw fail(404, 'user');
    db.reports.push({ id: rid(8), by: u.id, user: target, post: post ? post.id : null, reason: clip(b.reason, 200), at: now(), done: false });
    touch();
    return json(res, 200, { ok: true });
  }
  throw fail(404, 'not_found');
}
function leaveGroup(g, u) {
  g.members = g.members.filter((x) => x !== u.id);
  if (!g.members.length) {
    delete db.groups[g.id];
    return;
  }
  if (g.owner === u.id) g.owner = g.members[0];
  silent(g, u.id, { t: 'sync' });
}

/* ---------- ページ（招待・規約・プライバシー） ---------- */
function storeConf() {
  try {
    return JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
  } catch {
    return {};
  }
}
const pageLang = (req, q) => (q.get('lang') === 'ja' || (!q.get('lang') && /^ja\b/i.test(String(req.headers['accept-language'] || ''))) ? 'ja' : 'en');
const CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;color:#2B2633;background:#FFF6EE}main{max-width:720px;margin:0 auto;padding:32px 20px 60px}h1{font-size:26px;line-height:1.3;margin:0 0 6px}h2{font-size:18px;margin:28px 0 6px}a{color:#E8604C}.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;margin-bottom:24px}.logo img{width:40px;height:40px;border-radius:10px}.card{background:#fff;border-radius:22px;padding:28px 22px;text-align:center;box-shadow:0 6px 24px rgba(232,96,76,.12)}.btn{display:inline-block;margin:8px 4px 0;padding:14px 22px;border-radius:999px;background:#2B2633;color:#fff;text-decoration:none;font-weight:800}.btn.sub{background:#F3ECE2;color:#2B2633}.code{font:800 22px ui-monospace,Menlo,monospace;letter-spacing:.12em;background:#FFF1E6;border-radius:12px;padding:8px 14px;display:inline-block;margin:10px 0}.small{font-size:13px;color:#8A8396}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #eee;padding:8px;text-align:left;vertical-align:top}`;
const shell = (lang, title, body) => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main><div class="logo"><img src="/icon.png" alt="">Nowmoji</div>${body}</main></body></html>`;

function invitePage(req, q, code) {
  const lang = pageLang(req, q);
  const g = Object.values(db.groups).find((x) => x.code === code);
  const conf = storeConf();
  const store = conf.appStoreUrl || 'https://apps.apple.com/search?term=Nowmoji';
  const ja = lang === 'ja';
  if (!g) return shell(lang, 'Nowmoji', `<div class="card"><h1>${ja ? 'この招待は使えません' : 'This invite is no longer valid'}</h1><p>${ja ? 'グループが無くなったか、招待コードが変わりました。招待した人にもう一度送ってもらってください。' : 'The group was removed or the code changed. Ask your friend to send a new invite.'}</p></div>`);
  return shell(lang, 'Nowmoji', `<div class="card"><p>${ja ? 'Nowmoji で' : 'You’re invited to'}</p><h1>「${esc(g.name)}」${ja ? 'に招待されています' : ''}</h1><p class="small">${ja ? `いま ${g.members.length}人（最大5人）` : `${g.members.length} of 5 people`}</p>
<a class="btn" href="nowmoji://join/${esc(code)}">${ja ? 'アプリで参加する' : 'Join in the app'}</a><a class="btn sub" href="${esc(store)}">${ja ? 'アプリを入手する' : 'Get the app'}</a>
<p class="small" style="margin-top:22px">${ja ? 'アプリを入れたあと、この画面に戻って「アプリで参加する」を押すか、アプリで下のコードを入力してください。' : 'After installing, come back and tap “Join in the app”, or enter this code in the app.'}</p><div class="code">${esc(code)}</div></div>`);
}

const TERMS = {
  ja: `<h1>利用規約</h1><p class="small">最終更新：2026年11月26日</p>
<p>この利用規約は、Nowmoji 運営者（以下「運営者」）が提供するアプリ「Nowmoji」（以下「本アプリ」）の利用条件を定めるものです。本アプリを使った時点で、この規約に同意したものとします。</p>
<h2>1. 本アプリについて</h2><p>本アプリは、招待した親しい人同士で、いまの気分（顔文字・イラスト・落書き・画像・ひとこと）を共有するためのものです。投稿は同じグループのメンバーにだけ表示されます。</p>
<h2>2. 投稿の責任</h2><p>投稿した内容の責任は、投稿した人にあります。他人の権利（著作権・肖像権・プライバシーなど）を侵害するもの、法令に反するもの、暴力的・性的・差別的なもの、嫌がらせやいじめにあたるもの、なりすまし、迷惑行為となるものは投稿できません。</p>
<h2>3. 通報とブロック</h2><p>不適切な投稿や利用者は、アプリの中から通報・ブロックできます。運営者は通報を受けた内容を確認し、24時間以内を目安に、投稿の削除や利用者の利用停止など必要な対応を行います。対応の結果を個別にお知らせしないことがあります。</p>
<h2>4. 利用停止</h2><p>この規約に反する利用があった場合、運営者は予告なく投稿を削除し、利用を停止できます。</p>
<h2>5. 有料プラン（Nowmoji Plus）</h2><p>Nowmoji Plus は App Store の自動更新サブスクリプションです。料金はアプリ内に表示します。期間の終わる24時間前までに解約しない限り自動で更新されます。解約は iPhone の「設定」→ 自分の名前 →「サブスクリプション」からできます。無料体験がある場合、体験期間中に解約しなければ有料期間に移ります。返金は Apple の規定に従います。</p>
<h2>6. 免責</h2><p>運営者は、本アプリを提供し続けること、届くまでの時間、データが失われないことを保証しません。本アプリの利用によって生じた損害について、運営者に故意または重大な過失がある場合を除き、責任を負いません。</p>
<h2>7. 変更</h2><p>運営者は、必要に応じてこの規約を変更できます。変更後に本アプリを使った場合、変更に同意したものとします。</p>
<h2>8. お問い合わせ</h2><p><a href="/support?lang=ja">お問い合わせフォーム</a></p>`,
  en: `<h1>Terms of Use</h1><p class="small">Last updated: November 26, 2026</p>
<p>These terms govern your use of the Nowmoji app (the “App”) provided by the Nowmoji operator (the “Operator”). By using the App you agree to these terms.</p>
<h2>1. The App</h2><p>The App lets invited close friends share how they feel right now (kaomoji, illustrations, doodles, pictures and a short note). Posts are shown only to members of the same group.</p>
<h2>2. Your posts</h2><p>You are responsible for what you post. You may not post anything that infringes others’ rights (copyright, likeness, privacy, etc.), breaks the law, is violent, sexual or discriminatory, harasses or bullies others, impersonates someone, or is spam. There is no tolerance for objectionable content or abusive users.</p>
<h2>3. Reporting and blocking</h2><p>You can report or block any post or user from within the App. The Operator reviews reports and, typically within 24 hours, removes offending content and suspends users as needed.</p>
<h2>4. Suspension</h2><p>If you break these terms, the Operator may remove your posts and suspend your use without notice.</p>
<h2>5. Nowmoji Plus</h2><p>Nowmoji Plus is an auto-renewing App Store subscription. Prices are shown in the App. It renews automatically unless cancelled at least 24 hours before the end of the current period. Manage or cancel it in Settings → your name → Subscriptions. If a free trial is offered, it converts to a paid subscription unless cancelled during the trial. Refunds follow Apple’s policies. Apple’s standard EULA also applies: https://www.apple.com/legal/internet-services/itunes/dev/stdeula/</p>
<h2>6. Disclaimer</h2><p>The Operator does not guarantee uninterrupted service, delivery times or that data will never be lost, and is not liable for damages arising from use of the App except in cases of intent or gross negligence.</p>
<h2>7. Changes</h2><p>The Operator may update these terms. Continued use after an update means you accept it.</p>
<h2>8. Contact</h2><p><a href="/support?lang=en">Contact form</a></p>`,
};
const PRIVACY = {
  ja: `<h1>プライバシーポリシー</h1><p class="small">最終更新：2026年11月26日</p>
<p>Nowmoji（以下「本アプリ」）は、必要最小限の情報だけを扱います。</p>
<h2>扱う情報</h2><p>・あなたが決めた表示名、表示色、言語<br>・あなたが投稿した気分・ひとこと・落書き・画像と、その日時<br>・参加しているグループ、ブロックした相手、通報の内容<br>・通知を送るための端末の通知用トークン</p><p>電話番号、メールアドレス、連絡先、位置情報、広告ID は集めません。アカウントは端末ごとの匿名のものです。</p>
<h2>使い道</h2><p>グループのメンバーに投稿を届けること、通知を送ること、通報への対応と不正利用の防止のためだけに使います。広告や第三者への販売には使いません。</p>
<h2>外部サービス</h2><p>通知の送信に Expo（Expo Push Service）と Apple（APNs）を、データの保管にお借りしているサーバー（ConoHa）を使います。購入の処理は Apple が行い、本アプリは支払い情報を受け取りません。</p>
<h2>保存期間と削除</h2><p>投稿は最長400日で自動的に消えます。アプリの「設定」→「データを削除」から、あなたのアカウントと投稿・画像をいつでもすべて削除できます。</p>
<h2>お問い合わせ</h2><p><a href="/support?lang=ja">お問い合わせフォーム</a></p>`,
  en: `<h1>Privacy Policy</h1><p class="small">Last updated: November 26, 2026</p>
<p>Nowmoji (the “App”) handles only the minimum information it needs.</p>
<h2>What we handle</h2><p>• The display name, color and language you choose<br>• The moods, notes, doodles and pictures you post, and when<br>• The groups you are in, people you block, and reports you send<br>• Your device’s push notification token</p><p>We do not collect phone numbers, email addresses, contacts, location or advertising IDs. Accounts are anonymous and tied to your device.</p>
<h2>How we use it</h2><p>Only to deliver your posts to your group, send notifications, handle reports and prevent abuse. Never for advertising, and never sold to third parties.</p>
<h2>Services we use</h2><p>Expo (Expo Push Service) and Apple (APNs) to send notifications, and a rented server (ConoHa) to store data. Purchases are processed by Apple; the App never receives payment details.</p>
<h2>Retention and deletion</h2><p>Posts are deleted automatically after at most 400 days. You can delete your account and all your posts and pictures at any time from Settings → Delete my data in the App.</p>
<h2>Contact</h2><p><a href="/support?lang=en">Contact form</a></p>`,
};

/* ---------- 管理画面（通報の確認） ---------- */
function isAdmin(req) {
  const c = (String(req.headers.cookie || '').match(/(?:^|;\s*)nm_admin=([^;]+)/) || [])[1];
  if (!c) return false;
  const [exp, sig] = c.split('.');
  return Number(exp) > now() && sig === sign('admin.' + exp);
}
function adminLogin(msg, first) {
  return shell('ja', '管理', `<h1>Nowmoji 管理</h1><p>${esc(msg)}</p><form method="post" action="/admin/login"><input type="password" name="pw" minlength="10" required autocomplete="${first ? 'new-password' : 'current-password'}" style="font-size:16px;padding:10px;border-radius:10px;border:1px solid #ddd"> <button class="btn">${first ? '決める' : 'ログイン'}</button></form>`);
}
function adminPage() {
  const rows = db.reports.slice().reverse().slice(0, 200).map((r) => {
    const post = r.post ? db.posts.find((x) => x.id === r.post) : null;
    const who = db.users[r.user];
    const body = post ? (post.img ? `<img src="/img/${esc(post.img)}" style="max-width:120px;border-radius:8px">` : esc(post.kao || MOODS[post.mood]?.ja || '')) + (post.word ? `<br>${esc(post.word)}` : '') : '（投稿の指定なし）';
    return `<tr><td>${new Date(r.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}<br>${r.done ? '対応済み' : '<b>未対応</b>'}</td><td>${who ? esc(who.name) + (who.banned ? '（停止中）' : '') : '（削除済み）'}<br><span class="small">${esc(r.user)}</span></td><td>${body}<br><span class="small">理由：${esc(r.reason || '-')}</span></td><td><form method="post" action="/admin/act"><input type="hidden" name="id" value="${esc(r.id)}">${post ? '<button class="btn sub" name="a" value="delpost">投稿を削除</button>' : ''}${who && !who.banned ? '<button class="btn sub" name="a" value="ban">利用停止</button>' : ''}${!r.done ? '<button class="btn sub" name="a" value="done">対応済みにする</button>' : ''}</form></td></tr>`;
  });
  const users = Object.keys(db.users).length;
  const msgs = (db.messages || []).slice().reverse().slice(0, 50).map((x) => `<tr><td>${new Date(x.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</td><td style="white-space:pre-wrap">${esc(x.msg)}</td></tr>`).join('');
  return shell('ja', '管理', `<h2>お問い合わせ</h2><table>${msgs || '<tr><td>ありません</td></tr>'}</table><h1>通報</h1><p class="small">利用者 ${users}人・グループ ${Object.keys(db.groups).length}・投稿 ${db.posts.length}件</p><table><tr><th>日時</th><th>相手</th><th>内容</th><th></th></tr>${rows.join('') || '<tr><td colspan="4">通報はありません</td></tr>'}</table>`);
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
      // Web版の確認用（認証はヘッダーなので、どこからでも読めて問題ない）
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
    if ((mm = p.match(/^\/img\/([A-Za-z0-9_-]+\.(png|jpg))$/))) {
      const f = path.join(IMG, mm[1]);
      if (!fs.existsSync(f)) return json(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'Content-Type': mm[2] === 'png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(f).pipe(res);
    }
    if ((mm = p.match(/^\/j\/([a-z0-9]{4,16})$/))) return html(res, 200, invitePage(req, url.searchParams, mm[1]));
    if (p === '/terms' || p === '/privacy') {
      const lang = pageLang(req, url.searchParams);
      const body = (p === '/terms' ? TERMS : PRIVACY)[lang];
      return html(res, 200, shell(lang, p === '/terms' ? (lang === 'ja' ? '利用規約' : 'Terms of Use') : lang === 'ja' ? 'プライバシーポリシー' : 'Privacy Policy', body + `<p class="small" style="margin-top:30px"><a href="?lang=${lang === 'ja' ? 'en' : 'ja'}">${lang === 'ja' ? 'English' : '日本語'}</a></p>`));
    }
    if ((p === '/' || p === '/support') && req.method !== 'POST') {
      const lang = pageLang(req, url.searchParams);
      const ja = lang === 'ja';
      return html(res, 200, shell(lang, 'Nowmoji', `<h1>${ja ? '親しい人のロック画面に、いまの気分を。' : 'Your mood, on your close friends’ lock screens.'}</h1><p>${ja ? '顔文字やイラストで、いまの気分を親しい人だけに届けるアプリです。届いた気分は相手のロック画面やホーム画面のウィジェットに表示されます。' : 'Share how you feel right now with kaomoji and cute illustrations, only with the people you invite. It shows up on their lock screen and home screen widgets.'}</p><h2>${ja ? 'お問い合わせ' : 'Contact'}</h2>${url.searchParams.get('sent') ? `<p><b>${ja ? '送信しました。ありがとうございます。' : 'Sent. Thank you!'}</b></p>` : ''}<form method="post" action="/support?lang=${lang}"><p><textarea name="msg" required maxlength="2000" rows="6" style="width:100%;font:inherit;padding:10px;border-radius:12px;border:1px solid #e3d9cd" placeholder="${ja ? '内容（返信が必要な場合は連絡先も書いてください）' : 'Your message (include a way to reach you if you need a reply)'}"></textarea></p><button class="btn">${ja ? '送信する' : 'Send'}</button></form><p><a href="/terms?lang=${lang}">${ja ? '利用規約' : 'Terms of Use'}</a> ・ <a href="/privacy?lang=${lang}">${ja ? 'プライバシーポリシー' : 'Privacy Policy'}</a></p>`));
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
      res.writeHead(303, { Location: '/admin', 'Set-Cookie': `nm_admin=${exp}.${sign('admin.' + exp)}; Path=/; Max-Age=${7 * 86400}; HttpOnly; Secure; SameSite=Strict` });
      return res.end();
    }
    if (p === '/admin/act' && req.method === 'POST') {
      if (!isAdmin(req)) return html(res, 403, adminLogin('ログインしてください。', false));
      const f = new URLSearchParams(await readBody(req));
      const r = db.reports.find((x) => x.id === f.get('id'));
      if (r) {
        const a = f.get('a');
        if (a === 'delpost' && r.post) {
          const post = db.posts.find((x) => x.id === r.post);
          if (post?.img) await fsp.rm(path.join(IMG, post.img), { force: true });
          db.posts = db.posts.filter((x) => x.id !== r.post);
          byGroup.clear();
          for (const x of db.posts) indexPost(x);
          r.done = true;
        }
        if (a === 'ban' && db.users[r.user]) {
          const t = db.users[r.user];
          t.banned = true;
          for (const g of myGroups(t)) leaveGroup(g, t);
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
server.listen(PORT, '127.0.0.1', () => console.log('nowmoji on', PORT));
