// World Budget Book のサーバー機能（Tripfold のサーバーに同居）
//  - 暗号化バックアップ（中身はアプリで暗号化。サーバーは読めない）
//  - 共有の家計簿（夫婦・ルームシェア。共有するカテゴリだけ送る）＋ アプリなしで見られるWebページ ＋ スプレッドシート用CSV
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = function makeWbb({ DATA, send, readBody, limited }) {
  const BK = path.join(DATA, 'wbb', 'backup');
  const SH = path.join(DATA, 'wbb', 'share');
  for (const d of [BK, SH]) fs.mkdirSync(d, { recursive: true });
  const HEX = /^[0-9a-f]{32}$/;
  const CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
  const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const readJ = async (f) => {
    try {
      return JSON.parse(await fsp.readFile(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const writeJ = async (f, v) => {
    const tmp = f + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(v));
    await fsp.rename(tmp, f);
  };
  const body = async (req, limit) => {
    const buf = await readBody(req, limit);
    try {
      return JSON.parse(buf.toString('utf8') || '{}');
    } catch {
      throw Object.assign(new Error('bad json'), { status: 400 });
    }
  };
  const cleanEntry = (e) => ({
    id: String(e.id || '').slice(0, 60),
    date: /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : '',
    kind: e.kind === 'in' ? 'in' : 'out',
    amount: isFinite(Number(e.amount)) && Math.abs(Number(e.amount)) < 1e10 ? Math.round(Number(e.amount) * 100) / 100 || 0 : 0,
    currency: String(e.currency || '').toUpperCase().slice(0, 3),
    cat: String(e.cat || '').slice(0, 40),
    memo: String(e.memo || '').slice(0, 120),
  });
  const shareCsv = (sh) => {
    // 「=」「+」「-」「@」で始まる文字は表計算ソフトで数式として動くので、先頭に ' をつける
    const q = (v) => `"${(/^[=+\-@\t\r]/.test(String(v)) ? "'" : '') + String(v).replace(/"/g, '""')}"`;
    const rows = [];
    Object.values(sh.members || {}).forEach((m) => (m.entries || []).forEach((e) => rows.push([e.date, q(m.name), e.kind, e.amount, e.currency, q(e.cat), q(e.memo)].join(','))));
    rows.sort();
    return ['date,member,type,amount,currency,category,memo', ...rows].join('\n');
  };
  const sharePage = (sh) => {
    const all = [];
    Object.values(sh.members || {}).forEach((m) => (m.entries || []).forEach((e) => all.push({ ...e, who: m.name })));
    all.sort((a, b) => (a.date < b.date ? 1 : -1));
    const months = [...new Set(all.map((e) => e.date.slice(0, 7)))].slice(0, 6);
    const sum = (list) => {
      const t = {};
      list.filter((e) => e.kind === 'out').forEach((e) => (t[e.currency] = (t[e.currency] || 0) + e.amount));
      return Object.entries(t).map(([c, v]) => `${v.toFixed(2)} ${c}`).join(' + ') || '0';
    };
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(sh.name)} · World Budget Book</title>
<style>body{font-family:-apple-system,'Hiragino Sans',sans-serif;background:#FFF7EE;color:#3D2C3E;margin:0;padding:18px;max-width:720px;margin:auto}
h1{font-size:22px}.card{background:#fff;border-radius:18px;padding:14px;margin:12px 0;box-shadow:0 4px 14px rgba(201,169,155,.2)}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:6px 4px;border-bottom:1px solid #F2E6DD}td.n{text-align:right;white-space:nowrap}.sub{color:#9A8A99;font-size:12px}</style></head><body>
<h1>${esc(sh.name)}</h1><div class="sub">World Budget Book · ${esc(Object.values(sh.members || {}).map((m) => m.name).join(', '))}</div>
${months
  .map((mo) => {
    const l = all.filter((e) => e.date.startsWith(mo));
    return `<div class="card"><b>${mo}</b> <span class="sub">${esc(sum(l))}</span><table>${l
      .map((e) => `<tr><td>${e.date.slice(5)}</td><td>${esc(e.who)}</td><td>${esc(e.memo || e.cat)}</td><td class="sub">${esc(e.cat)}</td><td class="n">${e.kind === 'in' ? '+' : '-'}${e.amount.toFixed(2)} ${esc(e.currency)}</td></tr>`)
      .join('')}</table></div>`;
  })
  .join('')}
</body></html>`;
  };

  return async function wbb(req, res, url, p, ip) {
    // ---------- 暗号化バックアップ ----------
    let m = p.match(/^\/wbb\/v1\/backup\/([0-9a-f]{32})$/);
    if (m) {
      const id = m[1];
      const key = String(req.headers['x-key'] || '');
      if (!HEX.test(key)) return send(res, 401, { error: 'key' });
      const f = path.join(BK, `${id}.json`);
      const cur = await readJ(f);
      if (req.method === 'GET') {
        if (limited(ip, 'wbbbk-get', 120, 3600e3)) return send(res, 429, { error: 'too many' });
        if (!cur || cur.key !== sha(key)) return send(res, 404, { error: 'not found' });
        return send(res, 200, { blob: cur.blob, nonce: cur.nonce, at: cur.at });
      }
      if (req.method === 'PUT') {
        if (limited(ip, 'wbbbk-put', 60, 3600e3)) return send(res, 429, { error: 'too many' });
        if (cur && cur.key !== sha(key)) return send(res, 403, { error: 'forbidden' });
        const b = await body(req, 12 * 1024 * 1024);
        if (typeof b.blob !== 'string' || typeof b.nonce !== 'string' || b.blob.length > 11 * 1024 * 1024) return send(res, 400, { error: 'bad' });
        await writeJ(f, { key: sha(key), blob: b.blob, nonce: b.nonce, at: Date.now() });
        return send(res, 200, { ok: true, at: Date.now() });
      }
      if (req.method === 'DELETE') {
        if (!cur || cur.key !== sha(key)) return send(res, 404, { error: 'not found' });
        await fsp.unlink(f).catch(() => {});
        return send(res, 200, { ok: true });
      }
    }

    // ---------- 共有の家計簿 ----------
    if (p === '/wbb/v1/share' && req.method === 'POST') {
      if (limited(ip, 'wbbsh-new', 20, 3600e3)) return send(res, 429, { error: 'too many' });
      const b = await body(req, 64 * 1024);
      let code;
      do code = Array.from(crypto.randomBytes(8), (x) => ALPHA[x % ALPHA.length]).join('');
      while (fs.existsSync(path.join(SH, `${code}.json`)));
      await writeJ(path.join(SH, `${code}.json`), { name: String(b.name || 'Shared').slice(0, 60), created: Date.now(), members: {} });
      return send(res, 200, { code });
    }
    m = p.match(/^\/wbb\/v1\/share\/([0-9A-Z]{8})(?:\/([0-9a-f]{32}))?$/);
    if (m && CODE.test(m[1])) {
      const f = path.join(SH, `${m[1]}.json`);
      const sh = await readJ(f);
      if (!sh) return send(res, 404, { error: 'not found' });
      if (req.method === 'GET' && !m[2]) {
        if (limited(ip, 'wbbsh-get', 600, 3600e3)) return send(res, 429, { error: 'too many' });
        const members = Object.fromEntries(Object.entries(sh.members).map(([k, v]) => [k.slice(0, 8), { name: v.name, entries: v.entries, at: v.at }]));
        return send(res, 200, { name: sh.name, members });
      }
      // 自分の分を送る（メンバーの鍵＝32桁。最初に送った鍵の持ち主だけが上書きできる）
      if (req.method === 'PUT' && m[2]) {
        if (limited(ip, 'wbbsh-put', 300, 3600e3)) return send(res, 429, { error: 'too many' });
        const b = await body(req, 4 * 1024 * 1024);
        const mid = sha(m[2]).slice(0, 24);
        if (!sh.members[mid] && Object.keys(sh.members).length >= 8) return send(res, 403, { error: 'full' });
        const entries = (Array.isArray(b.entries) ? b.entries : []).slice(0, 5000).map(cleanEntry).filter((e) => e.date && e.amount);
        sh.members[mid] = { name: String(b.name || 'Member').slice(0, 30), entries, at: Date.now() };
        if (b.title) sh.name = String(b.title).slice(0, 60);
        await writeJ(f, sh);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && m[2]) {
        delete sh.members[sha(m[2]).slice(0, 24)];
        await writeJ(f, sh);
        return send(res, 200, { ok: true });
      }
    }
    // アプリなしで見られるページと、スプレッドシート（IMPORTDATA）用のCSV
    m = p.match(/^\/wbb\/(s|csv)\/([0-9A-Z]{8})(?:\.csv)?$/);
    if (m && req.method === 'GET') {
      if (limited(ip, 'wbbsh-page', 600, 3600e3)) return send(res, 429, { error: 'too many' });
      const sh = await readJ(path.join(SH, `${m[2]}.json`));
      if (!sh) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      if (m[1] === 'csv') return send(res, 200, shareCsv(sh), { 'Content-Type': 'text/csv; charset=utf-8' });
      return send(res, 200, sharePage(sh), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    return send(res, 404, { error: 'not found' });
  };
};
