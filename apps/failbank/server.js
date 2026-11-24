// FAILBANK（失敗データの共有）— 外部ライブラリなし・Node.js 22
//  - 失敗データの投稿（ステップ式）→ 運営の確認 → 公開
//  - 一覧・検索・絞り込み・詳細・保存（端末内）・通報
//  - 日本語・英語
//  - 管理画面（/admin。最初に開いた人がパスワードを決める）
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { T, CATS, catName } = require('./i18n');

const PORT = Number(process.env.PORT || 3102);
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const DIR = path.join(DATA, 'reports');
fs.mkdirSync(DIR, { recursive: true });
const SECRET_FILE = path.join(DATA, 'secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
const ADMIN_FILE = path.join(DATA, 'admin.json');
const CURRENCIES = ['JPY', 'USD', 'GBP', 'EUR'];
const MINOR = { JPY: 1, USD: 100, GBP: 100, EUR: 100 }; // 金額は最小通貨単位の整数で持つ

/* ---------- 小さな道具 ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x');
const buckets = new Map();
function limited(ip, kind, max, windowMs) {
  const key = `${kind}:${ip}`;
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || t - b.start > windowMs) {
    buckets.set(key, { start: t, n: 1 });
    return false;
  }
  return ++b.n > max;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (t - b.start > 3600e3) buckets.delete(k);
}, 600e3).unref();

async function readBody(req, limit = 64 * 1024) {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > limit) throw Object.assign(new Error('too large'), { status: 413 });
  }
  return s;
}
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const html = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", ...headers });
  res.end(body);
};

/* ---------- 保存 ---------- */
const file = (id) => path.join(DIR, id + '.json');
let index = null; // id → 投稿
async function load() {
  if (index) return index;
  index = new Map();
  for (const f of await fsp.readdir(DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(await fsp.readFile(path.join(DIR, f), 'utf8'));
      index.set(d.id, d);
    } catch {}
  }
  return index;
}
async function save(d) {
  d.updatedAt = Date.now();
  const tmp = file(d.id) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(d));
  await fsp.rename(tmp, file(d.id));
  (await load()).set(d.id, d);
}
async function remove(id) {
  await fsp.rm(file(id), { force: true });
  (await load()).delete(id);
}
const published = async () => [...(await load()).values()].filter((d) => d.status === 'published');

/* ---------- 入力の検査 ---------- */
const LIMITS = { title: 120, tried: 2000, goal: 600, outcome: 3000, causes: 3000, attempts: 2000, nextTime: 2000, tools: 300, name: 40, country: 40 };
const PERSONAL = /[\w.+-]+@[\w-]+\.[\w.-]+|\+\d[\d\s-]{8,}\d|\b0\d{1,4}[\s-]\d{1,4}[\s-]\d{3,4}\b|\b0[5789]0\d{8}\b|\b(?:sk|pk|rk)_(?:live|test)_\w+|\bAKIA[0-9A-Z]{12,}\b/; // メール・電話番号・APIキーらしきもの
const str = (v, n) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const num = (v, max) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[,，\s]/g, ''));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
};
function clean(b) {
  const d = {};
  for (const k of Object.keys(LIMITS)) d[k] = str(b[k], LIMITS[k]);
  d.category = CATS.some((c) => c[0] === b.category) ? b.category : null;
  d.currency = CURRENCIES.includes(b.currency) ? b.currency : 'JPY';
  const amount = num(b.spent, 1e9);
  d.spent = amount === null ? null : Math.round(amount * MINOR[d.currency]);
  d.hours = num(b.hours, 100000);
  if (d.hours !== null) d.hours = Math.round(d.hours);
  d.months = num(b.months, 600);
  if (d.months !== null) d.months = Math.round(d.months);
  const y = num(b.started, 2100);
  d.started = y !== null && y >= 1990 ? Math.round(y) : null;
  d.lang = b.lang === 'en' ? 'en' : 'ja';
  d.tools = d.tools ? d.tools.split(/[,、，]/).map((x) => x.trim()).filter(Boolean).slice(0, 10).join(', ') : '';
  return d;
}
function check(d, agreed) {
  if (!d.title || !d.category || !d.tried || !d.outcome || !d.causes || !agreed) return 'required';
  const all = Object.keys(LIMITS).map((k) => d[k]).join('\n');
  if (PERSONAL.test(all)) return 'personal';
  return null;
}

/* ---------- 言語 ---------- */
function langOf(req, url) {
  const q = url.searchParams.get('lang');
  if (q === 'ja' || q === 'en') return q;
  const ck = (String(req.headers.cookie || '').match(/(?:^|;\s*)lang=(ja|en)/) || [])[1];
  if (ck) return ck;
  return /^ja\b/i.test(String(req.headers['accept-language'] || '')) ? 'ja' : 'en';
}

/* ---------- 表示用 ---------- */
function money(minor, cur, L) {
  if (minor === null || minor === undefined) return null;
  const v = minor / MINOR[cur || 'JPY'];
  try {
    return new Intl.NumberFormat(L === 'ja' ? 'ja-JP' : 'en-GB', { style: 'currency', currency: cur || 'JPY', maximumFractionDigits: cur === 'JPY' ? 0 : 2 }).format(v);
  } catch {
    return `${v} ${cur}`;
  }
}
const jpyRough = (d) => (d.spent === null ? -1 : (d.spent / MINOR[d.currency]) * ({ JPY: 1, USD: 150, GBP: 190, EUR: 160 }[d.currency] || 1)); // 並べ替え用のおおよその円換算

const CSS = `
:root{--bg:#F7F8FA;--card:#fff;--ink:#151922;--sub:#5B6372;--line:#E4E7EC;--accent:#315CFF;--loss:#D94848;--ok:#16875D;--chip:#EEF1F6}
@media (prefers-color-scheme:dark){:root{--bg:#101217;--card:#181B22;--ink:#EEF0F4;--sub:#A3AAB8;--line:#2A2F3A;--accent:#6E8BFF;--loss:#F07272;--ok:#3CC48D;--chip:#222632}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP","Segoe UI",sans-serif;padding-bottom:calc(72px + env(safe-area-inset-bottom))}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:860px;margin:0 auto;padding:0 18px}
header.top{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
header.top .wrap{display:flex;align-items:center;gap:14px;height:58px}
.logo{font-weight:800;letter-spacing:.02em;color:var(--ink);font-size:20px}.logo b{color:var(--loss)}
.logo:hover{text-decoration:none}
nav.desk{margin-left:auto;display:flex;gap:18px;align-items:center;font-size:15px}nav.desk a{color:var(--sub)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 18px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:inherit;font-weight:600;cursor:pointer;text-decoration:none!important}
.btn.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.btn.blue{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.small{min-height:36px;padding:0 12px;font-size:14px}
.btn[disabled]{opacity:.5;cursor:default}
.lang{font-size:13px;color:var(--sub)}
.hero{padding:44px 0 26px}
.hero h1{font-size:clamp(26px,5vw,38px);line-height:1.3;margin:0 0 12px;letter-spacing:-.01em}
.hero p{color:var(--sub);margin:0 0 22px;max-width:640px}
form.search{display:flex;gap:8px}
form.search input{flex:1;min-width:0}
input,select,textarea{font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-height:44px;width:100%}
textarea{min-height:120px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
h2{font-size:20px;margin:34px 0 12px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:center;min-height:36px;padding:0 14px;border-radius:999px;background:var(--chip);color:var(--ink);font-size:14px;text-decoration:none!important}
.chip.on{background:var(--ink);color:var(--bg)}
.list{display:grid;gap:12px}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;color:var(--ink);text-decoration:none!important}
a.card:hover{border-color:var(--accent)}
.card .cat{font-size:13px;color:var(--sub)}
.card h3{margin:4px 0 12px;font-size:17px;line-height:1.5}
.nums{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.nums div{background:var(--bg);border-radius:10px;padding:8px 10px}
.nums small{display:block;color:var(--sub);font-size:12px}
.nums b{font-size:17px;font-variant-numeric:tabular-nums}
.nums b.loss{color:var(--loss)}
.nums .na{color:var(--sub);font-weight:400;font-size:14px}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:14px;padding:28px;text-align:center;color:var(--sub)}
.filters{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}
.meta{color:var(--sub);font-size:14px}
.badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:6px;background:var(--chip);color:var(--sub)}
article.detail h1{font-size:clamp(22px,4vw,30px);line-height:1.4;margin:8px 0 16px}
article.detail section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:12px 0}
article.detail section h2{font-size:15px;color:var(--sub);margin:0 0 6px}
.note{font-size:13px;color:var(--sub)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:20;background:var(--card);border-top:1px solid var(--line);display:flex;padding-bottom:env(safe-area-inset-bottom)}
.tabbar a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:58px;font-size:12px;color:var(--sub);text-decoration:none!important}
.tabbar a.on{color:var(--ink);font-weight:700}
.tabbar .ic{font-size:19px;line-height:1.2}
footer{margin:48px 0 20px;color:var(--sub);font-size:13px}
footer a{color:var(--sub)}
.step{display:none}.step.on{display:block}
.field{margin:16px 0}
.field label{display:block;font-weight:600;margin-bottom:6px}
.field .help{font-size:13px;color:var(--sub);margin-top:4px}
.req{font-size:11px;font-weight:600;color:var(--loss);margin-left:6px}
.opt{font-size:11px;color:var(--sub);margin-left:6px;font-weight:400}
.inline{display:grid;grid-template-columns:110px 1fr;gap:8px}
.bar{height:4px;background:var(--line);border-radius:4px;overflow:hidden;margin:10px 0 4px}.bar i{display:block;height:100%;background:var(--accent);transition:width .2s}
.err{color:var(--loss);font-size:14px;margin:10px 0;min-height:1em}
dialog{border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--ink);max-width:460px;width:calc(100% - 32px);padding:20px}
dialog::backdrop{background:rgba(0,0,0,.4)}
.radio{display:flex;gap:10px;align-items:flex-start;padding:8px 0}.radio input{width:auto;min-height:auto;margin-top:6px}
.check{display:flex;gap:10px;align-items:flex-start}.check input{width:22px;height:22px;min-height:auto;margin-top:3px;flex:none}
table.adm{width:100%;border-collapse:collapse;font-size:14px}table.adm td,table.adm th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
@media (min-width:760px){.tabbar{display:none}body{padding-bottom:0}}
@media (max-width:759px){nav.desk .hide-m{display:none}}
`;

function layout(L, { title, body, active = '', desc = '', url = '/' }) {
  const t = T[L];
  const other = L === 'ja' ? 'en' : 'ja';
  const sep = url.includes('?') ? '&' : '?';
  const tab = (href, ic, label, key) => `<a href="${href}" class="${active === key ? 'on' : ''}"><span class="ic" aria-hidden="true">${ic}</span>${esc(label)}</a>`;
  return `<!doctype html><html lang="${L}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title ? `${title} | FAILBANK` : `FAILBANK — ${t.tagline}`)}</title>
<meta name="description" content="${esc(desc || t.heroSub)}"><meta name="robots" content="noindex">
<meta name="theme-color" content="#151922"><style>${CSS}</style></head><body>
<header class="top"><div class="wrap"><a class="logo" href="/">FAIL<b>BANK</b></a>
<nav class="desk"><a class="hide-m" href="/r">${esc(t.explore)}</a><a class="hide-m" href="/saved">${esc(t.saved)}</a><a class="lang" href="${esc(url + sep)}lang=${other}">${other === 'ja' ? '日本語' : 'English'}</a><a class="btn small primary hide-m" href="/new">${esc(t.post)}</a></nav></div></header>
<main class="wrap">${body}</main>
<div class="wrap"><footer><p>${esc(t.footerNote)} ${esc(t.betaNote)}</p><p class="row"><a href="/terms">${esc(t.terms)}</a><a href="/privacy">${esc(t.privacy)}</a><span>© FAILBANK</span></p></footer></div>
<nav class="tabbar">${tab('/', '⌂', t.home, 'home')}${tab('/r', '⌕', t.explore, 'explore')}${tab('/new', '＋', t.postShort, 'new')}${tab('/saved', '☆', t.saved, 'saved')}</nav>
</body></html>`;
}

function card(d, L) {
  const t = T[L];
  const m = money(d.spent, d.currency, L);
  return `<a class="card" href="/r/${d.id}"><div class="cat">${esc(catName(d.category, L))}${d.lang !== L ? ` · <span class="badge">${d.lang === 'ja' ? '日本語' : 'English'}</span>` : ''}</div><h3>${esc(d.title)}</h3>
<div class="nums"><div><small>${esc(t.spent)}</small>${m ? `<b class="loss">${esc(m)}</b>` : `<b class="na">${esc(t.unknown)}</b>`}</div><div><small>${esc(t.hours)}</small>${d.hours !== null ? `<b>${esc(t.hoursV(d.hours))}</b>` : `<b class="na">${esc(t.unknown)}</b>`}</div><div><small>${esc(t.period)}</small>${d.months !== null ? `<b>${esc(t.months(d.months))}</b>` : `<b class="na">${esc(t.unknown)}</b>`}</div></div></a>`;
}

/* ---------- ページ ---------- */
async function pageHome(L) {
  const t = T[L];
  const items = (await published()).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 10);
  const body = `<section class="hero"><h1>${esc(t.heroTitle)}</h1><p>${esc(t.heroSub)}</p>
<form class="search" action="/r" method="get"><input name="q" placeholder="${esc(t.searchPh)}" aria-label="${esc(t.search)}"><button class="btn primary">${esc(t.search)}</button></form></section>
<h2>${esc(t.whichAvoid)}</h2><div class="chips">${CATS.map((c) => `<a class="chip" href="/r?c=${c[0]}">${esc(catName(c[0], L))}</a>`).join('')}</div>
<h2 class="row" style="justify-content:space-between">${esc(t.latest)} <a href="/r" style="font-size:14px;font-weight:400">${esc(t.viewAll)}</a></h2>
${items.length ? `<div class="list">${items.map((d) => card(d, L)).join('')}</div>` : `<div class="empty"><p>${esc(t.emptyAll)}<br>${esc(t.emptyCta)}</p><a class="btn blue" href="/new">${esc(t.post)}</a></div>`}
<h2>${esc(t.aiSoon)}</h2><div class="card"><p style="margin:0" class="meta">${esc(t.aiSoonBody)}</p></div>`;
  return layout(L, { body, active: 'home' });
}

async function pageList(L, url) {
  const t = T[L];
  const q = str(url.searchParams.get('q'), 100);
  const c = url.searchParams.get('c') || '';
  const sort = url.searchParams.get('sort') || 'new';
  let items = await published();
  if (c) items = items.filter((d) => d.category === c);
  if (q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    items = items.filter((d) => {
      const hay = [d.title, d.tried, d.goal, d.outcome, d.causes, d.attempts, d.nextTime, d.tools, d.country, catName(d.category, 'ja'), catName(d.category, 'en')].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  items.sort(sort === 'spent' ? (a, b) => jpyRough(b) - jpyRough(a) : sort === 'hours' ? (a, b) => (b.hours ?? -1) - (a.hours ?? -1) : (a, b) => b.publishedAt - a.publishedAt);
  const qs = (o) => '/r?' + new URLSearchParams(Object.entries({ q, c, sort, ...o }).filter(([, v]) => v && v !== 'new')).toString();
  const body = `<h1 style="font-size:24px;margin:26px 0 12px">${esc(t.explore)}</h1>
<form class="search" action="/r" method="get"><input name="q" value="${esc(q)}" placeholder="${esc(t.searchPh)}" aria-label="${esc(t.search)}">${c ? `<input type="hidden" name="c" value="${esc(c)}">` : ''}<button class="btn primary">${esc(t.search)}</button></form>
<div class="chips" style="margin:14px 0"><a class="chip ${c ? '' : 'on'}" href="${esc(qs({ c: '' }))}">${esc(t.all)}</a>${CATS.map((x) => `<a class="chip ${c === x[0] ? 'on' : ''}" href="${esc(qs({ c: x[0] }))}">${esc(catName(x[0], L))}</a>`).join('')}</div>
<div class="row" style="justify-content:space-between;margin:8px 0 12px"><span class="meta">${esc(t.results(items.length))}</span>
<span class="row meta">${esc(t.sort)}: ${[['new', t.sortNew], ['spent', t.sortSpent], ['hours', t.sortHours]].map(([k, v]) => (k === sort ? `<b>${esc(v)}</b>` : `<a href="${esc(qs({ sort: k }))}">${esc(v)}</a>`)).join(' · ')}</span></div>
${items.length ? `<div class="list">${items.slice(0, 100).map((d) => card(d, L)).join('')}</div>` : `<div class="empty">${esc(t.noResults)}<p><a class="btn blue" href="/new">${esc(t.post)}</a></p></div>`}`;
  return layout(L, { title: t.explore, body, active: 'explore', url: url.pathname + url.search });
}

function pageDetail(L, d, url) {
  const t = T[L];
  const m = money(d.spent, d.currency, L);
  const sec = (h, v) => (v ? `<section><h2>${esc(h)}</h2><div>${nl2br(v)}</div></section>` : '');
  const facts = [[t.started, d.started], [t.country, d.country], [t.tools, d.tools], [t.by, d.name || t.anon]].filter(([, v]) => v).map(([k, v]) => `<div><span class="meta">${esc(k)}：</span>${esc(v)}</div>`).join('');
  const body = `<article class="detail"><p class="meta" style="margin:24px 0 0"><a href="/r?c=${esc(d.category)}">${esc(catName(d.category, L))}</a> · <span class="badge" title="${esc(t.selfReportedNote)}">${esc(t.selfReported)}</span></p>
<h1>${esc(d.title)}</h1>
<div class="nums"><div><small>${esc(t.spent)}</small>${m ? `<b class="loss">${esc(m)}</b>` : `<b class="na">${esc(t.unknown)}</b>`}</div><div><small>${esc(t.hours)}</small>${d.hours !== null ? `<b>${esc(t.hoursV(d.hours))}</b>` : `<b class="na">${esc(t.unknown)}</b>`}</div><div><small>${esc(t.period)}</small>${d.months !== null ? `<b>${esc(t.months(d.months))}</b>` : `<b class="na">${esc(t.unknown)}</b>`}</div></div>
${sec(t.tried, d.tried)}${sec(t.goal, d.goal)}${sec(t.outcome, d.outcome)}${sec(t.causes, d.causes)}${sec(t.attempts, d.attempts)}${sec(t.nextTime, d.nextTime)}
${facts ? `<section>${facts}</section>` : ''}
<p class="note">${esc(t.selfReportedNote)}</p>
<div class="row"><button class="btn" id="sv" data-id="${esc(d.id)}">☆ ${esc(t.save)}</button><button class="btn" id="fl">${esc(t.flag)}</button></div></article>
<dialog id="dlg"><form method="dialog" id="ff"><h3 style="margin-top:0">${esc(t.flagTitle)}</h3>${t.flagReasons.map(([k, v], i) => `<label class="radio"><input type="radio" name="r" value="${k}" ${i === 0 ? 'checked' : ''}>${esc(v)}</label>`).join('')}
<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" value="cancel">${esc(t.back)}</button><button class="btn primary" id="fs" value="send">${esc(t.flagSend)}</button></div></form></dialog>
<script>
(function(){var id=${JSON.stringify(d.id)},K='fb_saved',b=document.getElementById('sv');
function get(){try{return JSON.parse(localStorage.getItem(K)||'[]')}catch(e){return[]}}
function put(a){try{localStorage.setItem(K,JSON.stringify(a))}catch(e){}}
function draw(){var on=get().indexOf(id)>=0;b.textContent=(on?'★ ':'☆ ')+(on?${JSON.stringify(t.unsave)}:${JSON.stringify(t.save)})}
b.onclick=function(){var a=get(),i=a.indexOf(id);if(i>=0)a.splice(i,1);else a.unshift(id);put(a.slice(0,500));draw()};draw();
var dlg=document.getElementById('dlg');document.getElementById('fl').onclick=function(){dlg.showModal()};
dlg.addEventListener('close',function(){if(dlg.returnValue!=='send')return;var r=document.querySelector('input[name=r]:checked').value;
fetch('/api/reports/'+id+'/flag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:r})}).then(function(){alert(${JSON.stringify(t.flagThanks)})})});})();
</script>`;
  return layout(L, { title: d.title, body, desc: d.outcome.slice(0, 120), url: url.pathname + url.search });
}

function pageSaved(L) {
  const t = T[L];
  const body = `<h1 style="font-size:24px;margin:26px 0 12px">${esc(t.savedTitle)}</h1><div id="out" class="list"></div>
<script>
(function(){var a=[];try{a=JSON.parse(localStorage.getItem('fb_saved')||'[]')}catch(e){}
var out=document.getElementById('out');if(!a.length){out.innerHTML='<div class="empty">'+${JSON.stringify(esc(t.savedEmpty))}+'</div>';return}
fetch('/api/cards?lang=${L}&ids='+encodeURIComponent(a.slice(0,100).join(','))).then(function(r){return r.text()}).then(function(h){out.innerHTML=h||'<div class="empty">'+${JSON.stringify(esc(t.savedEmpty))}+'</div>'})})();
</script>`;
  return layout(L, { title: t.savedTitle, body, active: 'saved', url: '/saved' });
}

function pageNew(L) {
  const t = T[L];
  const f = (name, label, input, { req = false, help = '' } = {}) => `<div class="field"><label for="${name}">${esc(label)}${req ? `<span class="req">${esc(t.required)}</span>` : `<span class="opt">${esc(t.optional)}</span>`}</label>${input}${help ? `<div class="help">${esc(help)}</div>` : ''}</div>`;
  const ta = (n, ph = '', rows = 5) => `<textarea id="${n}" name="${n}" rows="${rows}" maxlength="${LIMITS[n] || 2000}" placeholder="${esc(ph)}"></textarea>`;
  const steps = [
    f('title', t.f_title, `<input id="title" name="title" maxlength="${LIMITS.title}" placeholder="${esc(t.f_titlePh)}">`, { req: true }) +
      f('category', t.f_category, `<select id="category" name="category"><option value=""></option>${CATS.map((c) => `<option value="${c[0]}">${esc(catName(c[0], L))}</option>`).join('')}</select>`, { req: true }) +
      f('tried', t.f_tried, ta('tried', t.f_triedPh), { req: true }) +
      f('goal', t.f_goal, `<input id="goal" name="goal" maxlength="${LIMITS.goal}" placeholder="${esc(t.f_goalPh)}">`),
    f('spent', t.f_spent, `<div class="inline"><select name="currency" aria-label="currency">${CURRENCIES.map((c) => `<option ${c === (L === 'ja' ? 'JPY' : 'USD') ? 'selected' : ''}>${c}</option>`).join('')}</select><input id="spent" name="spent" inputmode="decimal" placeholder="0"></div>`, { help: t.f_spentHelp }) +
      f('hours', t.f_hours, `<input id="hours" name="hours" inputmode="numeric" placeholder="0">`) +
      f('months', t.f_period, `<input id="months" name="months" inputmode="numeric" placeholder="0">`) +
      f('started', t.f_started, `<input id="started" name="started" inputmode="numeric" placeholder="${new Date().getFullYear()}">`) +
      f('country', t.f_country, `<input id="country" name="country" maxlength="${LIMITS.country}" placeholder="${L === 'ja' ? '日本' : 'Japan'}">`),
    f('outcome', t.f_outcome, ta('outcome', t.f_outcomePh, 6), { req: true }) + f('causes', t.f_causes, ta('causes', '', 6), { req: true }) + f('attempts', t.f_attempts, ta('attempts')) + f('nextTime', t.f_next, ta('nextTime')),
    f('tools', t.f_tools, `<input id="tools" name="tools" maxlength="${LIMITS.tools}" placeholder="${esc(t.f_toolsPh)}">`) +
      f('name', t.f_name, `<input id="name" name="name" maxlength="${LIMITS.name}" placeholder="${esc(t.f_namePh)}">`) +
      `<div class="field"><label class="check"><input type="checkbox" id="agree" name="agree">${esc(t.f_agree)}</label></div>`,
  ];
  const body = `<h1 style="font-size:24px;margin:26px 0 6px">${esc(t.newTitle)}</h1><p class="meta">${esc(t.newLead)}</p>
<div class="bar"><i id="bar" style="width:25%"></i></div><div class="meta" id="stepn">${esc(t.step(1, steps.length))}</div>
<form id="nf" novalidate>${steps.map((s, i) => `<div class="step ${i === 0 ? 'on' : ''}">${s}</div>`).join('')}
<input type="hidden" name="lang" value="${L}"><input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
<div class="err" id="err" role="alert"></div>
<div class="row" style="justify-content:space-between"><button type="button" class="btn" id="bk" style="visibility:hidden">${esc(t.back)}</button><button type="button" class="btn primary" id="nx">${esc(t.next)}</button></div></form>
<div id="done" hidden><div class="card"><h2 style="margin-top:0">${esc(t.doneTitle)}</h2><p>${esc(t.doneBody)}</p><p><b>${esc(t.deleteLink)}</b></p><input id="dl" readonly><p><button class="btn" id="cp">${esc(t.copy)}</button></p></div></div>
<script>
(function(){var n=${steps.length},i=0,steps=[].slice.call(document.querySelectorAll('.step')),nx=document.getElementById('nx'),bk=document.getElementById('bk'),err=document.getElementById('err'),f=document.getElementById('nf');
var REQ=[['title','category','tried'],[],['outcome','causes'],['agree']];
function val(k){var e=f.elements[k];return e.type==='checkbox'?e.checked:String(e.value).trim()}
function show(){steps.forEach(function(s,j){s.classList.toggle('on',j===i)});bk.style.visibility=i?'visible':'hidden';nx.textContent=i===n-1?${JSON.stringify(t.submit)}:${JSON.stringify(t.next)};
document.getElementById('bar').style.width=((i+1)/n*100)+'%';document.getElementById('stepn').textContent=(i+1)+' / '+n;err.textContent='';window.scrollTo(0,0)}
bk.onclick=function(){if(i>0){i--;show()}};
nx.onclick=function(){for(var k=0;k<REQ[i].length;k++){if(!val(REQ[i][k])){err.textContent=${JSON.stringify(t.errRequired)};f.elements[REQ[i][k]].focus();return}}
if(i<n-1){i++;show();return}
var o={};[].forEach.call(f.elements,function(e){if(e.name)o[e.name]=e.type==='checkbox'?e.checked:e.value});
nx.disabled=true;nx.textContent=${JSON.stringify(t.sending)};
fetch('/api/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)}).then(function(r){return r.json().then(function(j){return[r.status,j]})}).then(function(a){
if(a[0]===200){f.hidden=true;document.getElementById('bar').style.width='100%';var u=location.origin+'/delete/'+a[1].id+'#'+a[1].key;document.getElementById('dl').value=u;document.getElementById('done').hidden=false;window.scrollTo(0,0);return}
var m={required:${JSON.stringify(t.errRequired)},personal:${JSON.stringify(t.errPersonal)},too_many:${JSON.stringify(t.errTooMany)}};err.textContent=m[a[1].error]||${JSON.stringify(t.errGeneric)};nx.disabled=false;nx.textContent=${JSON.stringify(t.submit)}
}).catch(function(){err.textContent=${JSON.stringify(t.errGeneric)};nx.disabled=false;nx.textContent=${JSON.stringify(t.submit)}})};
document.getElementById('cp').onclick=function(){var e=document.getElementById('dl');e.select();try{navigator.clipboard.writeText(e.value)}catch(x){document.execCommand('copy')}this.textContent=${JSON.stringify(t.copied)}};})();
</script>`;
  return layout(L, { title: t.newTitle, body, active: 'new', url: '/new' });
}

function pageDelete(L, id) {
  const t = T[L];
  const body = `<div class="card" style="margin-top:30px"><h2 style="margin-top:0">${esc(t.delTitle)}</h2><p id="msg" class="meta"></p><button class="btn primary" id="del">${esc(t.delBtn)}</button></div>
<script>
document.getElementById('del').onclick=function(){var b=this;b.disabled=true;fetch('/api/reports/'+${JSON.stringify(id)}+'/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:location.hash.slice(1)})}).then(function(r){
document.getElementById('msg').textContent=r.ok?${JSON.stringify(t.delDone)}:${JSON.stringify(t.errGeneric)};if(!r.ok)b.disabled=false})};
</script>`;
  return layout(L, { title: t.delTitle, body, url: '/delete/' + id });
}

function pageLegal(L, kind) {
  const ja = {
    terms: ['利用規約', `本サービス「FAILBANK」（以下「本サービス」）は、事業や副業などの失敗の経験を共有し、他の人が同じ失敗を避けるために役立てることを目的としています。

1. 投稿内容は投稿者本人の実体験に限ります。他人の体験を本人の許可なく投稿すること、作り話や宣伝目的の投稿は禁止します。
2. 個人情報（氏名・連絡先など）、第三者の機密情報、認証情報（パスワード・APIキーなど）、誹謗中傷を含む投稿は禁止します。
3. 投稿は運営が確認したうえで公開します。規約に反すると判断した投稿は、予告なく非公開・削除することがあります。
4. 投稿の著作権は投稿者に残ります。投稿者は、本サービスでの表示・検索・紹介のために、運営が投稿内容を無償で利用することを許諾するものとします。
5. 掲載内容は投稿者の申告であり、運営は正確さや有用性を保証しません。掲載内容をもとにした判断・行動の結果について、運営は責任を負いません。
6. 投稿者は、投稿時に表示される削除用リンクから、いつでも投稿を削除できます。
7. 本規約は必要に応じて変更することがあります。変更後の規約は本ページに掲載した時点で効力を生じます。`],
    privacy: ['プライバシーポリシー', `1. 集める情報：投稿された内容（表示名を含む）と、不正な投稿を防ぐための技術的な情報（アクセス元のIPアドレス・日時）を扱います。IPアドレスは短期間の回数制限のためだけに使い、投稿データには保存しません。
2. 端末に保存する情報：「保存」した失敗データの一覧と言語の設定は、お使いの端末（ブラウザ）の中に保存し、運営のサーバーには送りません。
3. 利用目的：投稿の表示・検索、内容の確認、不正利用の防止のためにだけ使います。
4. 第三者への提供：法令に基づく場合を除き、本人の同意なく第三者に提供しません。広告や行動解析の仕組みは使っていません。
5. 投稿の削除：投稿時に表示される削除用リンクから、いつでも削除できます。
6. 保存場所：日本国内のサーバー（VPS）に保存します。`],
  };
  const en = {
    terms: ['Terms of use', `FAILBANK ("the service") exists so people can share failures in business and side projects and help others avoid them.

1. Posts must describe your own experience. Do not post other people's stories without permission, made-up stories, or promotion.
2. Do not post personal data (names, contact details), confidential third-party information, credentials (passwords, API keys) or abusive content.
3. Posts are published after review. We may hide or delete posts that break these terms without notice.
4. You keep the copyright of your post. You grant us a free licence to display, index and feature it within the service.
5. Posts are self-reported. We do not guarantee their accuracy or usefulness, and are not responsible for decisions made based on them.
6. You can delete your post at any time with the delete link shown when you post.
7. We may update these terms. Changes take effect when published on this page.`],
    privacy: ['Privacy policy', `1. What we handle: the content you post (including your display name) and technical data used to prevent abuse (IP address and time of access). IP addresses are only used briefly for rate limiting and are not stored with posts.
2. On your device: your saved list and language choice are stored in your browser, not on our server.
3. Purpose: displaying and searching posts, reviewing them, and preventing abuse.
4. Sharing: we do not share data with third parties without your consent unless required by law. We do not use advertising or behavioural tracking.
5. Deleting: you can delete your post at any time with the delete link shown when you post.
6. Storage: data is stored on a server (VPS) in Japan.`],
  };
  const [title, text] = (L === 'ja' ? ja : en)[kind];
  return layout(L, { title, body: `<h1 style="font-size:24px;margin:26px 0 12px">${esc(title)}</h1><div class="card">${nl2br(text)}</div>`, url: '/' + kind });
}

/* ---------- 管理画面 ---------- */
const scrypt = (pw, s) => crypto.scryptSync(pw, s, 32).toString('hex');
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function isAdmin(req) {
  const c = (String(req.headers.cookie || '').match(/(?:^|;\s*)fb_admin=([^;]+)/) || [])[1];
  if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = sign('admin.' + exp);
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
const sameOrigin = (req) => {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    return new URL(o).host === req.headers.host;
  } catch {
    return false;
  }
};
function adminLogin(msg, first) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>管理 | FAILBANK</title><style>${CSS}</style></head><body><main class="wrap"><h1 style="font-size:22px;margin:30px 0 10px">FAILBANK 管理</h1><p>${esc(msg)}</p>
<form method="post" action="/admin/login" class="row"><input type="password" name="pw" minlength="10" required autocomplete="${first ? 'new-password' : 'current-password'}" style="max-width:280px"><button class="btn primary">${first ? '決める' : 'ログイン'}</button></form></main></body></html>`;
}
async function adminPage() {
  const all = [...(await load()).values()].sort((a, b) => b.createdAt - a.createdAt);
  const pending = all.filter((d) => d.status === 'pending');
  const flagged = all.filter((d) => d.flags?.length && d.status === 'published');
  const rowOf = (d) => `<tr><td><b>${esc(d.title)}</b><div class="meta">${esc(catName(d.category, 'ja'))} · ${esc(d.lang)} · ${new Date(d.createdAt).toISOString().slice(0, 16).replace('T', ' ')} · ${esc(d.status)}${d.flags?.length ? ` · 通報${d.flags.length}件（${esc(d.flags.map((f) => f.reason).join(', '))}）` : ''}</div>
<details><summary>内容を見る</summary><div class="meta">${['tried', 'goal', 'outcome', 'causes', 'attempts', 'nextTime', 'tools', 'name', 'country'].map((k) => (d[k] ? `<p><b>${k}</b><br>${nl2br(d[k])}</p>` : '')).join('')}<p>金額 ${esc(money(d.spent, d.currency, 'ja') || '-')} / ${d.hours ?? '-'}時間 / ${d.months ?? '-'}か月 / ${d.started ?? '-'}年</p></div></details></td>
<td><form method="post" action="/admin/act" class="row"><input type="hidden" name="id" value="${esc(d.id)}">${d.status !== 'published' ? '<button class="btn small blue" name="a" value="publish">公開</button>' : ''}${d.status !== 'rejected' ? '<button class="btn small" name="a" value="reject">非公開</button>' : ''}${d.flags?.length ? '<button class="btn small" name="a" value="clear">通報を解除</button>' : ''}<button class="btn small" name="a" value="delete">削除</button></form></td></tr>`;
  const table = (rows) => (rows.length ? `<table class="adm">${rows.map(rowOf).join('')}</table>` : '<p class="meta">ありません</p>');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>管理 | FAILBANK</title><style>${CSS}</style></head><body><main class="wrap">
<h1 style="font-size:22px;margin:24px 0 4px">FAILBANK 管理</h1><p class="meta">全${all.length}件（公開${all.filter((d) => d.status === 'published').length}・確認待ち${pending.length}・通報あり${flagged.length}）</p>
<h2>確認待ち</h2>${table(pending)}<h2>通報された公開中の投稿</h2>${table(flagged)}<h2>すべて</h2>${table(all.slice(0, 200))}</main></body></html>`;
}

/* ---------- ルーティング ---------- */
const server = http.createServer(async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const L = langOf(req, url);
  const setLang = url.searchParams.has('lang') ? { 'Set-Cookie': `lang=${L}; Path=/; Max-Age=31536000; SameSite=Lax` } : {};
  try {
    if (limited(ip, 'all', 300, 60e3)) return json(res, 429, { error: 'too_many' });
    if (p === '/health') return json(res, 200, { ok: true, app: 'failbank' });
    if (p === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /\n'); // 試験公開中は検索に出さない
    }
    if (req.method === 'GET') {
      if (p === '/') return html(res, 200, await pageHome(L), setLang);
      if (p === '/r') return html(res, 200, await pageList(L, url), setLang);
      const m = p.match(/^\/r\/([a-z0-9]{6,12})$/);
      if (m) {
        const d = (await load()).get(m[1]);
        if (!d || d.status !== 'published') return html(res, 404, layout(L, { title: '404', body: `<div class="empty" style="margin-top:30px">404</div>` }));
        return html(res, 200, pageDetail(L, d, url), setLang);
      }
      if (p === '/saved') return html(res, 200, pageSaved(L), setLang);
      if (p === '/new') return html(res, 200, pageNew(L), setLang);
      const dm = p.match(/^\/delete\/([a-z0-9]{6,12})$/);
      if (dm) return html(res, 200, pageDelete(L, dm[1]), setLang);
      if (p === '/terms' || p === '/privacy') return html(res, 200, pageLegal(L, p.slice(1)), setLang);
      if (p === '/api/cards') {
        const ids = String(url.searchParams.get('ids') || '').split(',').slice(0, 100);
        const idx = await load();
        const list = ids.map((id) => idx.get(id)).filter((d) => d && d.status === 'published');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(list.map((d) => card(d, L)).join(''));
      }
      if (p === '/admin') {
        if (!isAdmin(req)) return html(res, 200, adminLogin(fs.existsSync(ADMIN_FILE) ? 'パスワードを入力してください。' : '初めて開きました。管理用のパスワード（10文字以上）を決めてください。', !fs.existsSync(ADMIN_FILE)));
        return html(res, 200, await adminPage());
      }
    }
    if (req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'forbidden' });
      if (p === '/api/reports') {
        if (limited(ip, 'post', 5, 3600e3)) return json(res, 429, { error: 'too_many' });
        let b;
        try {
          b = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: 'bad' });
        }
        if (b.website) return json(res, 200, { id: newId(), key: 'x' }); // 自動投稿よけ（見えない欄が埋まっていたら捨てる）
        const d = clean(b);
        const bad = check(d, b.agree === true || b.agree === 'on');
        if (bad) return json(res, 400, { error: bad });
        const key = crypto.randomBytes(18).toString('base64url');
        const doc = { id: newId(), ...d, status: 'pending', verification: 'self', flags: [], keyHash: hash(key), createdAt: Date.now() };
        await save(doc);
        console.log('new report', doc.id);
        return json(res, 200, { id: doc.id, key });
      }
      const fm = p.match(/^\/api\/reports\/([a-z0-9]{6,12})\/(flag|delete)$/);
      if (fm) {
        const d = (await load()).get(fm[1]);
        let b = {};
        try {
          b = JSON.parse(await readBody(req, 4096));
        } catch {}
        if (fm[2] === 'flag') {
          if (limited(ip, 'flag', 20, 3600e3)) return json(res, 429, { error: 'too_many' });
          if (!d || d.status !== 'published') return json(res, 404, { error: 'not_found' });
          const reason = ['personal', 'fake', 'abuse', 'other'].includes(b.reason) ? b.reason : 'other';
          const who = hash(SECRET + ip).slice(0, 12);
          if (!d.flags.some((f) => f.who === who)) d.flags.push({ reason, who, at: Date.now() });
          await save(d);
          return json(res, 200, { ok: true });
        }
        if (limited(ip, 'del', 20, 3600e3)) return json(res, 429, { error: 'too_many' });
        if (!d || typeof b.key !== 'string' || hash(b.key) !== d.keyHash) return json(res, 403, { error: 'forbidden' });
        await remove(d.id);
        return json(res, 200, { ok: true });
      }
      if (p === '/admin/login') {
        if (limited(ip, 'login', 10, 600e3)) return html(res, 429, adminLogin('しばらく待ってからお試しください。', false));
        const pw = new URLSearchParams(await readBody(req, 2000)).get('pw') || '';
        let saved = null;
        try {
          saved = JSON.parse(await fsp.readFile(ADMIN_FILE, 'utf8'));
        } catch {}
        if (!saved) {
          if (pw.length < 10) return html(res, 200, adminLogin('10文字以上で決めてください。', true));
          const s = crypto.randomBytes(16).toString('hex');
          await fsp.writeFile(ADMIN_FILE, JSON.stringify({ s, h: scrypt(pw, s) }), { mode: 0o600 });
        } else if (!crypto.timingSafeEqual(Buffer.from(scrypt(pw, saved.s), 'hex'), Buffer.from(saved.h, 'hex'))) {
          return html(res, 200, adminLogin('パスワードが違います。', false));
        }
        const exp = Date.now() + 7 * 86400e3;
        res.writeHead(303, { Location: '/admin', 'Set-Cookie': `fb_admin=${exp}.${sign('admin.' + exp)}; Path=/; Max-Age=${7 * 86400}; HttpOnly; Secure; SameSite=Strict` });
        return res.end();
      }
      if (p === '/admin/act') {
        if (!isAdmin(req)) return json(res, 403, { error: 'forbidden' });
        const f = new URLSearchParams(await readBody(req, 2000));
        const d = (await load()).get(f.get('id'));
        if (d) {
          const a = f.get('a');
          if (a === 'publish') {
            d.status = 'published';
            d.publishedAt = d.publishedAt || Date.now();
            d.flags = [];
          } else if (a === 'reject') d.status = 'rejected';
          else if (a === 'clear') d.flags = [];
          if (a === 'delete') await remove(d.id);
          else await save(d);
        }
        res.writeHead(303, { Location: '/admin' });
        return res.end();
      }
    }
    return html(res, 404, layout(L, { title: '404', body: `<div class="empty" style="margin-top:30px">404</div>` }));
  } catch (e) {
    console.error(e);
    return json(res, e.status || 500, { error: 'server' });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log('failbank listening on', PORT));
