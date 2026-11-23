// みんなのしおり：アプリで作った旅を公開する・Webで見る・自分の旅にコピーする
//  - 公開するときに、予約番号・座席・金額・払った人・メンバー・メモ・写真・書類は送らない（アプリ側でも消すが、サーバーでも捨てる）
//  - 日付は「1日目・2日目」に置き換えて保存する（いつ旅行したかを公開しない）
//  - ページの予約リンクには sub_id を付け、どのしおりから予約されたかが分かるようにする（書き手への還元に使う）
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = function makePublic({ DATA, send, readJson, limited, APP_STORE }) {
  const DIR = path.join(DATA, 'public');
  fs.mkdirSync(DIR, { recursive: true });
  const ID = /^[a-z0-9]{10}$/;
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const newId = () => Array.from(crypto.randomBytes(10), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const str = (x, n) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
  const file = (id) => path.join(DIR, id + '.json');
  const readJ = async (f) => {
    try {
      return JSON.parse(await fsp.readFile(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const writeJ = async (f, v) => {
    const tmp = f + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(v));
    await fsp.rename(tmp, f);
  };

  /* ---------- 一覧（メモリに持つ。数千件までなら十分） ---------- */
  let index = null;
  async function loadIndex() {
    if (index) return index;
    index = new Map();
    for (const f of await fsp.readdir(DIR)) {
      if (!f.endsWith('.json')) continue;
      const d = await readJ(path.join(DIR, f));
      if (d && !d.hidden) index.set(d.id, summary(d));
    }
    return index;
  }
  const summary = (d) => ({ id: d.id, name: d.trip.name, emoji: d.trip.emoji, days: d.trip.days, cities: d.trip.cities, countries: d.trip.countries, author: d.author, lang: d.lang, n: d.trip.items.length, updatedAt: d.updatedAt });

  /* ---------- 受け取った旅を、公開してよい形にする ---------- */
  const TYPES = ['flight', 'train', 'bus', 'hotel', 'car', 'ticket', 'food', 'plan', 'other'];
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME = /^\d{2}:\d{2}$/;
  const dayNo = (d, first) => Math.round((Date.parse(d) - Date.parse(first)) / 864e5) + 1;
  function sanitize(body) {
    const t = body && body.trip;
    if (!t || !Array.isArray(t.bookings)) return null;
    const bs = t.bookings.filter((b) => b && TYPES.includes(b.type) && !b.cancelled && DATE.test(b.start || '') && str(b.title, 120));
    if (bs.length < 2) return null;
    const first = bs.map((b) => b.start).sort()[0];
    const items = bs
      .map((b) => ({
        type: b.type,
        title: str(b.title, 120),
        day: Math.max(1, Math.min(60, dayNo(b.start, first))),
        time: TIME.test(b.startTime || '') ? b.startTime : undefined,
        endDay: DATE.test(b.end || '') ? Math.max(1, Math.min(61, dayNo(b.end, first))) : undefined,
        endTime: TIME.test(b.endTime || '') ? b.endTime : undefined,
        // 住所は公開しない（個人宅の可能性がある）。駅・空港・街の名前だけ残る from/to は乗り物のときだけ
        from: ['flight', 'train', 'bus'].includes(b.type) ? str(b.from, 80) || undefined : undefined,
        to: ['flight', 'train', 'bus'].includes(b.type) ? str(b.to, 80) || undefined : undefined,
      }))
      .sort((a, b) => a.day - b.day || String(a.time || '99').localeCompare(String(b.time || '99')));
    const days = Math.max(...items.map((i) => Math.max(i.day, i.endDay || 1)), 1);
    const list = (a, n) => (Array.isArray(a) ? a.map((x) => str(x, 40)).filter(Boolean).slice(0, n) : []);
    return {
      name: str(t.name, 60) || 'Trip',
      emoji: str(t.emoji, 8) || undefined,
      days,
      cities: list(body.cities, 12),
      countries: list(body.countries, 12).filter((c) => /^[A-Z]{2}$/.test(c)),
      note: str(body.note, 600) || undefined,
      items,
    };
  }

  /* ---------- 予約リンク（sub_id 付き） ---------- */
  const enc = encodeURIComponent;
  const TP = { marker: '804335', trs: '599453' };
  const TPB = { klook: ['137', '4110'], airalo: ['541', '8310'], kkday: ['633', '9074'] };
  const tp = (brand, url, sub) => `https://tp.media/r?campaign_id=${TPB[brand][0]}&marker=${TP.marker}&p=${TPB[brand][1]}&trs=${TP.trs}&sub_id=${enc(sub)}&u=${enc(url)}`;
  const RAKUTEN = '59674a62.6f5d1f31.59674a63.cf344897';
  const GYG = 'LCIKN6S';
  function linksFor(d) {
    const sub = 't_' + d.id;
    const out = [];
    const jp = d.trip.countries.includes('JP');
    for (const c of d.trip.cities.slice(0, 3)) {
      const rk = `https://kw.travel.rakuten.co.jp/keyword/Search.do?charset=utf-8&f_query=${enc(c)}`;
      out.push({ k: 'hotel', city: c, links: [
        ...(jp ? [{ n: '楽天トラベル', u: `https://hb.afl.rakuten.co.jp/hgc/${RAKUTEN}/?pc=${enc(rk)}&m=${enc(rk)}` }] : []),
        { n: 'Booking.com', u: `https://www.booking.com/searchresults.html?ss=${enc(c)}` },
      ] });
      out.push({ k: 'do', city: c, links: [
        { n: 'Klook', u: tp('klook', `https://www.klook.com/search/result/?query=${enc(c)}`, sub) },
        { n: 'KKday', u: tp('kkday', `https://www.kkday.com/en/product/productlist?keyword=${enc(c)}`, sub) },
        { n: 'GetYourGuide', u: `https://www.getyourguide.com/s/?q=${enc(c)}&partner_id=${GYG}&cmp=${enc(sub)}` },
      ] });
    }
    if (d.trip.countries.some((c) => c !== 'JP') || !jp) out.push({ k: 'esim', links: [{ n: 'Airalo', u: tp('airalo', 'https://www.airalo.com/', sub) }, { n: 'Klook eSIM', u: tp('klook', 'https://www.klook.com/search/result/?query=eSIM', sub) }] });
    return out;
  }
  const itemLink = (it, d) => (['ticket', 'plan'].includes(it.type) ? tp('klook', `https://www.klook.com/search/result/?query=${enc([it.title, d.trip.cities[0]].filter(Boolean).join(' '))}`, 't_' + d.id) : null);

  /* ---------- 画面の言葉 ---------- */
  const W = {
    ja: { list: 'みんなのしおり', listSub: '旅行した人が公開した、そのまま使える旅程です。気に入ったらアプリにコピーして、自分の旅に合わせて直せます。', day: '日目', days: '日間', copy: 'Tripfold にコピーする', getApp: 'App Store で Tripfold を入手', hotel: '宿を探す', do: 'ツアー・チケットを探す', esim: '現地で使える eSIM', by: '作成', pr: '予約サイトへのリンクには提携リンクを含みます。', empty: 'まだ公開されたしおりはありません。', report: '不適切な内容を報告', note: '作った人のひとこと', more: 'ほかのしおり', type: { flight: '飛行機', train: '電車', bus: 'バス', hotel: '宿', car: 'レンタカー', ticket: 'チケット', food: '食事', plan: '予定', other: 'その他' } },
    en: { list: 'Trip plans by travellers', listSub: 'Real itineraries shared by people who took the trip. Copy one into the app and make it yours.', day: 'Day ', days: ' days', copy: 'Copy to Tripfold', getApp: 'Get Tripfold on the App Store', hotel: 'Find a place to stay', do: 'Tours and tickets', esim: 'eSIM for the trip', by: 'by', pr: 'Some booking links are affiliate links.', empty: 'No shared plans yet.', report: 'Report this page', note: 'From the author', more: 'More plans', type: { flight: 'Flight', train: 'Train', bus: 'Bus', hotel: 'Stay', car: 'Car', ticket: 'Ticket', food: 'Food', plan: 'Plan', other: 'Other' } },
  };
  const langOf = (req) => (/^ja/i.test(String(req.headers['accept-language'] || '')) ? 'ja' : 'en');
  const dayLabel = (w, n, L) => (L === 'ja' ? `${n}${w.day}` : `${w.day}${n}`);
  const ICON = { flight: '✈️', train: '🚆', bus: '🚌', hotel: '🛏️', car: '🚗', ticket: '🎟️', food: '🍽️', plan: '📍', other: '•' };
  const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0)));
  const ORIGIN = 'https://tripfold.160-251-171-249.sslip.io';

  function page(res, status, { title, desc, canonical, L, body, index: idx = true }) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...(idx ? {} : { 'X-Robots-Tag': 'noindex' }) });
    res.end(`<!doctype html><html lang="${L}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">${canonical ? `<link rel="canonical" href="${ORIGIN}${canonical}">` : ''}${idx ? '' : '<meta name="robots" content="noindex">'}
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta name="apple-itunes-app" content="app-id=6833397163">
<style>*{box-sizing:border-box}body{margin:0;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans",sans-serif;color:#15171C;background:#F4F3EF}
main{max-width:760px;margin:0 auto;padding:24px 18px 60px}a{color:#15171C}nav{font-size:14px;margin-bottom:14px}nav a{text-decoration:none;font-weight:700}
.k{font-size:12px;letter-spacing:.14em;font-weight:800;color:#FF5B3A}h1{font-size:30px;line-height:1.25;margin:6px 0 8px}h2{font-size:20px;margin:28px 0 8px}
.meta{color:#8C9099;font-size:14px}.card{background:#fff;border-radius:16px;padding:14px 16px;margin:10px 0;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.it{display:flex;gap:12px;padding:9px 0;border-bottom:1px solid #F0EEE9}.it:last-child{border:0}.ic{width:26px;text-align:center}.tm{color:#8C9099;font-size:13px;min-width:44px}.go{font-size:13px;font-weight:700;color:#FF5B3A;text-decoration:none;white-space:nowrap}
.btn{display:block;text-align:center;background:#15171C;color:#fff;text-decoration:none;font-weight:800;padding:15px;border-radius:14px;margin:10px 0}.btn2{background:#fff;color:#15171C;border:1px solid #DDD}
.links a{display:inline-block;background:#fff;border:1px solid #DDD;border-radius:12px;padding:7px 12px;margin:4px 6px 4px 0;text-decoration:none;font-weight:700;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.tile{display:block;background:#fff;border-radius:16px;padding:14px 16px;text-decoration:none;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.tile b{display:block;font-size:17px;line-height:1.35;margin:4px 0}.pr{font-size:12px;color:#8C9099;margin-top:30px}</style></head><body><main>${body}
<p class="pr">${esc(W[L].pr)} · <a href="/legal">特定商取引法に基づく表記</a> · <a href="/privacy">Privacy</a> · © Tripfold</p></main></body></html>`);
  }

  function tripBody(d, L, others) {
    const w = W[L];
    const t = d.trip;
    const byDay = new Map();
    for (const it of t.items) {
      if (!byDay.has(it.day)) byDay.set(it.day, []);
      byDay.get(it.day).push(it);
    }
    const days = [...byDay.keys()].sort((a, b) => a - b).map((n) => `<h2>${esc(dayLabel(w, n, L))}</h2><div class="card">${byDay.get(n).map((it) => {
      const lk = itemLink(it, d);
      const sub = it.from || it.to ? `<div class="meta">${esc([it.from, it.to].filter(Boolean).join(' → '))}</div>` : '';
      return `<div class="it"><span class="tm">${esc(it.time || '')}</span><span class="ic">${ICON[it.type]}</span><span style="flex:1">${esc(it.title)}${sub}</span>${lk ? `<a class="go" rel="sponsored nofollow" href="${esc(lk)}">${L === 'ja' ? '予約' : 'Book'}</a>` : ''}</div>`;
    }).join('')}</div>`).join('');
    const links = linksFor(d).map((g) => `<div class="card"><b>${esc(g.k === 'hotel' ? `${w.hotel}：${g.city}` : g.k === 'do' ? `${w.do}：${g.city}` : w.esim)}</b><div class="links">${g.links.map((l) => `<a rel="sponsored nofollow" href="${esc(l.u)}">${esc(l.n)}</a>`).join('')}</div></div>`).join('');
    const deep = `tripfold://pub?id=${d.id}`;
    return `<nav><a href="/t">← ${esc(w.list)}</a></nav><div class="k">${esc(t.countries.map(flag).join(' '))} ${esc(t.days + w.days)}</div>
<h1>${esc((t.emoji ? t.emoji + ' ' : '') + t.name)}</h1><div class="meta">${esc(t.cities.join(' · '))}${d.author ? ` · ${esc(w.by)} ${esc(d.author)}` : ''}</div>
${t.note ? `<div class="card"><div class="meta">${esc(w.note)}</div>${esc(t.note).replace(/\n/g, '<br>')}</div>` : ''}
<a class="btn" href="${deep}">${esc(w.copy)}</a><a class="btn btn2" href="${APP_STORE}">${esc(w.getApp)}</a>
${days}${links ? `<h2>${L === 'ja' ? 'この旅の予約' : 'Book this trip'}</h2>${links}` : ''}
${others.length ? `<h2>${esc(w.more)}</h2><div class="grid">${others.map(tile(L)).join('')}</div>` : ''}
<p class="meta" style="margin-top:24px"><a href="mailto:info@anzenshorui.com?subject=${enc('Report /t/' + d.id)}">${esc(w.report)}</a></p>`;
  }
  const tile = (L) => (s) => `<a class="tile" href="/t/${s.id}"><span class="meta">${esc(s.countries.map(flag).join(' '))} ${esc(s.days + W[L].days)}</span><b>${esc((s.emoji ? s.emoji + ' ' : '') + s.name)}</b><span class="meta">${esc(s.cities.slice(0, 4).join(' · '))}</span></a>`;

  /* ---------- 入口 ---------- */
  return async function handle(req, res, url, p, ip) {
    // 公開する
    if (p === '/v1/pub' && req.method === 'POST') {
      if (limited(ip, 'pub', 20, 60 * 60 * 1000)) return send(res, 429, { error: 'too many' });
      const body = await readJson(req);
      const trip = sanitize(body);
      if (!trip) return send(res, 400, { error: 'need at least 2 plans with dates' });
      let id = newId();
      while (fs.existsSync(file(id))) id = newId();
      const key = crypto.randomBytes(16).toString('hex');
      const d = { id, keyHash: sha(key), author: str(body.author, 30) || undefined, lang: body.lang === 'ja' ? 'ja' : 'en', trip, createdAt: Date.now(), updatedAt: Date.now() };
      await writeJ(file(id), d);
      (await loadIndex()).set(id, summary(d));
      return send(res, 200, { id, key, url: `${ORIGIN}/t/${id}` });
    }
    let m = p.match(/^\/v1\/pub\/([a-z0-9]{10})$/);
    if (m) {
      const d = await readJ(file(m[1]));
      if (!d || (d.hidden && req.method === 'GET')) return send(res, 404, { error: 'not found' });
      // アプリにコピーするためのデータ
      if (req.method === 'GET') return send(res, 200, { id: d.id, author: d.author, trip: d.trip });
      const key = String(req.headers['x-pub-key'] || '');
      if (!key || sha(key) !== d.keyHash) return send(res, 403, { error: 'forbidden' });
      // 公開をやめる
      if (req.method === 'DELETE') {
        await fsp.rm(file(d.id), { force: true });
        (await loadIndex()).delete(d.id);
        return send(res, 200, { ok: true });
      }
      // 内容を直す
      if (req.method === 'PUT') {
        const body = await readJson(req);
        const trip = sanitize(body);
        if (!trip) return send(res, 400, { error: 'need at least 2 plans with dates' });
        Object.assign(d, { trip, author: str(body.author, 30) || undefined, updatedAt: Date.now() });
        await writeJ(file(d.id), d);
        (await loadIndex()).set(d.id, summary(d));
        return send(res, 200, { ok: true, url: `${ORIGIN}/t/${d.id}` });
      }
    }
    // 一覧ページ
    if (p === '/t' && req.method === 'GET') {
      const L = langOf(req);
      const w = W[L];
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 40);
      let all = [...(await loadIndex()).values()].sort((a, b) => b.updatedAt - a.updatedAt);
      if (q) all = all.filter((s) => [s.name, ...s.cities].join(' ').toLowerCase().includes(q));
      const body = `<nav><a href="/">Tripfold</a> · <a href="/guides">Guides</a></nav><div class="k">TRIP PLANS</div><h1>${esc(w.list)}</h1><p class="meta">${esc(w.listSub)}</p>
<form action="/t" style="margin:14px 0"><input name="q" value="${esc(q)}" placeholder="${L === 'ja' ? '都市名で探す（例：京都、London）' : 'Search by city'}" style="width:100%;font:16px inherit;padding:11px 12px;border:1px solid #DDD;border-radius:12px"></form>
${all.length ? `<div class="grid">${all.slice(0, 120).map(tile(L)).join('')}</div>` : `<div class="card">${esc(w.empty)}</div>`}
<a class="btn btn2" href="${APP_STORE}">${esc(w.getApp)}</a>`;
      return page(res, 200, { title: `${w.list} | Tripfold`, desc: w.listSub, canonical: '/t', L, body, index: !q });
    }
    // 各しおりのページ
    m = p.match(/^\/t\/([a-z0-9]{10})$/);
    if (m && req.method === 'GET') {
      const L = langOf(req);
      const d = await readJ(file(m[1]));
      if (!d || d.hidden) return page(res, 404, { title: 'Tripfold', desc: '', L, body: `<h1>${L === 'ja' ? 'このしおりは見つかりません' : 'Plan not found'}</h1><a class="btn" href="/t">${esc(W[L].list)}</a>`, index: false });
      const idx = await loadIndex();
      const others = [...idx.values()].filter((s) => s.id !== d.id && s.cities.some((c) => d.trip.cities.includes(c))).slice(0, 6);
      const t = d.trip;
      const desc = `${t.cities.join('・')} ${t.days}${W[L].days}: ${t.items.slice(0, 6).map((i) => i.title).join(' / ')}`.slice(0, 160);
      return page(res, 200, { title: `${t.name} | ${W[L].list}`, desc, canonical: `/t/${d.id}`, L, body: tripBody(d, L, others) });
    }
    return false;
  };
};
