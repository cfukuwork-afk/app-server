// サイトの閲覧数（PV）を自前で数える。Cookie は使わず、IPアドレスもそのままは保存しない
//  - 日ごとに data/stats/YYYY-MM-DD.json へ { pv, uv, pages, refs, sp } を保存
//  - 訪問者数は「IP＋ブラウザ＋日ごとの乱数」のハッシュで数え、日が変わると元に戻せない
//  - /stats は最初に開いた人がパスワードを決める（以後はそのパスワードで見る）
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const BOT = /bot|crawl|spider|slurp|preview|fetch|monitor|curl|wget|python|node|axios|headless|lighthouse|facebookexternalhit|embedly|whatsapp|telegram|discord|slack/i;
const PAGE = /^\/($|t($|\/[0-9a-z]+$)|guides($|\/[a-z0-9-]+$)|dna\/[0-9a-z]+$|privacy$|legal$)/;

module.exports = function makeStats({ DATA }) {
  const DIR = path.join(DATA, 'stats');
  fs.mkdirSync(DIR, { recursive: true });
  const PASS = path.join(DIR, 'pass.json');
  let day = '';
  let cur = null;
  let salt = '';
  let seen = new Set();
  let dirty = false;
  const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // 日本時間で区切る
  const file = (d) => path.join(DIR, d + '.json');

  function roll() {
    const d = today();
    if (d === day) return;
    flush();
    day = d;
    salt = crypto.randomBytes(16).toString('hex');
    try {
      cur = JSON.parse(fs.readFileSync(file(d), 'utf8'));
    } catch {
      cur = { pv: 0, uv: 0, pages: {}, refs: {}, sp: 0 };
    }
    seen = new Set();
  }
  function flush() {
    if (!dirty || !cur) return;
    dirty = false;
    fsp.writeFile(file(day), JSON.stringify(cur)).catch(() => {});
  }
  setInterval(flush, 60 * 1000).unref();

  function hit(req, p, ip) {
    if (req.method !== 'GET' || !PAGE.test(p)) return;
    const ua = String(req.headers['user-agent'] || '');
    if (!ua || BOT.test(ua) || ip === 'self') return;
    roll();
    cur.pv++;
    const key = p.startsWith('/t/') ? '/t/*' : p.startsWith('/dna/') ? '/dna/*' : p;
    cur.pages[key] = (cur.pages[key] || 0) + 1;
    if (p.startsWith('/t/')) cur.pages[p] = (cur.pages[p] || 0) + 1;
    const v = crypto.createHash('sha256').update(salt + ip + ua).digest('hex').slice(0, 16);
    if (!seen.has(v)) {
      seen.add(v);
      cur.uv++;
      if (/iPhone|Android/i.test(ua)) cur.sp++;
    }
    let ref = '';
    try {
      ref = new URL(String(req.headers.referer || '')).hostname.replace(/^www\./, '');
    } catch {}
    if (ref && ref !== 'tripfold.net') cur.refs[ref] = (cur.refs[ref] || 0) + 1;
    dirty = true;
  }

  // ---- 見るページ ----
  const hash = (pw, s) => crypto.scryptSync(pw, s, 32).toString('hex');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const page = (body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>閲覧数 | Tripfold</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#222}table{border-collapse:collapse;width:100%;margin:8px 0 24px}td,th{border-bottom:1px solid #eee;padding:6px;text-align:left;font-size:14px}td.n{text-align:right}input,button{font-size:16px;padding:8px}.k{display:flex;gap:12px;flex-wrap:wrap}.k div{background:#f5f5f2;border-radius:10px;padding:12px 16px}.k b{display:block;font-size:24px}</style></head><body>${body}</body></html>`;
  const form = (msg, first) => page(`<h1>閲覧数</h1><p>${msg}</p><form method="post" action="/stats"><input type="password" name="pw" autocomplete="${first ? 'new-password' : 'current-password'}" placeholder="パスワード" required minlength="8"> <button>${first ? '決める' : '見る'}</button></form>`);

  async function readForm(req) {
    let s = '';
    for await (const c of req) {
      s += c;
      if (s.length > 2000) break;
    }
    return new URLSearchParams(s).get('pw') || '';
  }
  async function view(res) {
    roll();
    flush();
    const days = [...new Set([...(await fsp.readdir(DIR)).filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f)), day + '.json'])].sort().slice(-30).reverse();
    const rows = [];
    const pages = {};
    const refs = {};
    for (const f of days) {
      const d = f === day + '.json' ? cur : JSON.parse(await fsp.readFile(path.join(DIR, f), 'utf8'));
      rows.push(`<tr><td>${f.slice(0, 10)}</td><td class="n">${d.pv}</td><td class="n">${d.uv}</td><td class="n">${d.uv ? Math.round((d.sp / d.uv) * 100) : 0}%</td></tr>`);
      for (const [k, n] of Object.entries(d.pages)) pages[k] = (pages[k] || 0) + n;
      for (const [k, n] of Object.entries(d.refs)) refs[k] = (refs[k] || 0) + n;
    }
    const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v}</td></tr>`).join('');
    const t = cur;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page(`<h1>閲覧数（直近30日）</h1><div class="k"><div>今日のPV<b>${t.pv}</b></div><div>今日の訪問者<b>${t.uv}</b></div></div>
<h2>日別</h2><table><tr><th>日付</th><th>PV</th><th>訪問者</th><th>スマホ</th></tr>${rows.join('')}</table>
<h2>よく見られたページ</h2><table>${top(pages, 30)}</table>
<h2>どこから来たか</h2><table>${top(refs, 20) || '<tr><td>まだありません</td></tr>'}</table>
<p style="color:#888;font-size:12px">ボット・検索エンジンの巡回は除いています。訪問者数は同じ日の同じ端末を1人として数えています。</p>`));
  }

  async function route(req, res, p, ip, limited) {
    if (p !== '/stats') return false;
    let saved = null;
    try {
      saved = JSON.parse(await fsp.readFile(PASS, 'utf8'));
    } catch {}
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(saved ? form('パスワードを入力してください。', false) : form('初めて開きました。閲覧数を見るためのパスワード（8文字以上）を決めてください。', true));
      return true;
    }
    if (req.method !== 'POST') return false;
    if (limited(ip, 'stats', 10, 10 * 60 * 1000)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('しばらく待ってからもう一度お試しください。');
      return true;
    }
    const pw = await readForm(req);
    if (!saved) {
      if (pw.length < 8) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(form('8文字以上で決めてください。', true));
        return true;
      }
      const s = crypto.randomBytes(16).toString('hex');
      await fsp.writeFile(PASS, JSON.stringify({ s, h: hash(pw, s) }), { mode: 0o600 });
      await view(res);
      return true;
    }
    const ok = crypto.timingSafeEqual(Buffer.from(hash(pw, saved.s), 'hex'), Buffer.from(saved.h, 'hex'));
    if (!ok) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(form('パスワードが違います。', false));
      return true;
    }
    await view(res);
    return true;
  }

  return { hit, route };
};
