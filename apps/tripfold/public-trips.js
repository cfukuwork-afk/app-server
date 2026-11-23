// みんなのしおり：アプリで作った旅を公開する・Webで見る・自分の旅にコピーする
//  - 公開するときに、予約番号・座席・金額・払った人・メンバー・メモ・写真・書類は送らない（アプリ側でも消すが、サーバーでも捨てる）
//  - 日付は「1日目・2日目」に置き換えて保存する（いつ旅行したかを公開しない）
//  - ページの予約リンクには sub_id を付け、どのしおりから予約されたかが分かるようにする（書き手への還元に使う）
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = function makePublic({ DATA, send, readJson, limited, APP_STORE, PORT }) {
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

  /* ---------- 写真・説明・道のり（公開したあとに、サーバーが少しずつ調べて付け足す） ---------- */
  // 場所：このサーバーの「場所探し」を使う／道のり：このサーバーの「道のり」を使う／写真と説明：Wikipedia
  const LOCAL = `http://127.0.0.1:${PORT}`;
  const UA = { 'User-Agent': 'Tripfold/1.0 (travel planner app; https://tripfold.160-251-171-249.sslip.io)' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SPOT = ['ticket', 'plan', 'food', 'other', 'hotel'];
  const kmBetween = (a, b) => Math.hypot(a.lat - b.lat, (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180)) * 111;
  async function locate(q, near, lang) {
    try {
      const u = new URL(LOCAL + '/v1/geo/search');
      u.searchParams.set('q', q);
      if (near) {
        u.searchParams.set('lat', String(near.lat));
        u.searchParams.set('lng', String(near.lng));
      }
      const r = await fetch(u, { headers: { 'Accept-Language': lang }, signal: AbortSignal.timeout(30000) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }
  async function route(a, b) {
    const km = kmBetween(a, b);
    const mode = km <= 2.5 ? 'foot' : 'car';
    try {
      const r = await fetch(`${LOCAL}/v1/geo/route?mode=${mode}&from=${a.lat},${a.lng}&to=${b.lat},${b.lng}`, { signal: AbortSignal.timeout(30000) });
      if (r.ok) {
        const j = await r.json();
        return { mode, min: j.min, km: j.km, line: (j.coords || []).filter((_, i, arr) => i % Math.max(1, Math.ceil(arr.length / 60)) === 0 || i === arr.length - 1) };
      }
    } catch {}
    // 道が引けないときは、まっすぐの距離から目安を出す
    return { mode, min: Math.max(1, Math.round(mode === 'foot' ? km * 14 : km * 2.2 + 5)), km: Math.round(km * 10) / 10, rough: true };
  }
  async function wiki(q, lang, near, big) {
    for (const l of [lang, 'en']) {
      try {
        const u = new URL(`https://${l}.wikipedia.org/w/api.php`);
        Object.entries({ action: 'query', format: 'json', generator: 'search', gsrsearch: q, gsrlimit: '3', prop: 'pageimages|extracts|coordinates|info', inprop: 'url', exintro: '1', explaintext: '1', exsentences: '3', exlimit: '3', piprop: 'thumbnail', pithumbsize: big ? '1600' : '800', coprimary: 'primary' }).forEach(([k, v]) => u.searchParams.set(k, v));
        const j = await (await fetch(u, { headers: UA, signal: AbortSignal.timeout(8000) })).json();
        const pages = Object.values(j?.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        for (const pg of pages) {
          const c = pg.coordinates?.[0];
          // 違う場所の記事を拾わないよう、位置が近いものだけ使う
          if (near && (!c || kmBetween(near, { lat: c.lat, lng: c.lon }) > (big ? 60 : 25))) continue;
          if (!pg.thumbnail?.source && !pg.extract) continue;
          return { img: pg.thumbnail?.source, desc: String(pg.extract || '').replace(/\s*\([^)]*\)/g, '').slice(0, 260), title: pg.title, url: pg.fullurl, lang: l };
        }
      } catch {}
      await sleep(300);
    }
    return null;
  }
  const running = new Set();
  async function enrich(id) {
    if (running.has(id)) return;
    running.add(id);
    try {
      const d = await readJ(file(id));
      if (!d) return;
      const L = d.lang === 'ja' ? 'ja' : 'en';
      const t = d.trip;
      const cityQ = [t.cities[0], t.countries[0]].filter(Boolean).join(', ');
      const center = t.cities[0] ? await locate(cityQ, null, L) : null;
      const items = [];
      for (const it of t.items) {
        if (!SPOT.includes(it.type)) {
          items.push(null);
          continue;
        }
        const g = await locate(`${it.title}${t.cities[0] ? ', ' + t.cities[0] : ''}`, center, L);
        const w = g && it.type !== 'food' ? await wiki(it.title, L, g, false) : null;
        items.push(g ? { lat: g.lat, lng: g.lng, ...(w ? { img: w.img, desc: w.desc, wt: w.title, wu: w.url } : {}) } : null);
      }
      // 同じ日の、続けて行く2か所の道のり
      const legs = {};
      for (let i = 0; i < t.items.length; i++) {
        const a = items[i];
        if (!a) continue;
        for (let j = i + 1; j < t.items.length; j++) {
          if (t.items[j].day !== t.items[i].day) break;
          if (!SPOT.includes(t.items[j].type)) break;
          const b = items[j];
          if (!b) continue;
          if (kmBetween(a, b) < 40) legs[`${i}`] = await route(a, b);
          break;
        }
      }
      const hero = t.cities[0] ? await wiki(t.cities[0], L, center, true) : null;
      const now = (await readJ(file(id))) || d;
      if (JSON.stringify(now.trip) !== JSON.stringify(t)) return; // 調べている間に直された
      now.enrich = { at: Date.now(), items, legs, hero: hero ? { img: hero.img, desc: hero.desc, title: hero.title, url: hero.url } : null };
      await writeJ(file(id), now);
    } catch {
    } finally {
      running.delete(id);
    }
  }

  /* ---------- 日本語の改行：助詞や「・」のあとで折り返す（単語の途中で切れないように） ---------- */
  const jp = (x) =>
    esc(x).replace(/([ぁ-んァ-ヶー一-龠々〆ヵヶ]+?)([はがをにでとのへやもから、。・）」』！？])(?=[^、。・）」』！？\s])/g, '$1$2<wbr>');

  /* ---------- 画面の言葉 ---------- */
  const W = {
    ja: { list: 'みんなのしおり', listSub: '旅行した人が公開した、そのまま使える旅程です。写真と地図つきで、移動時間までわかります。気に入ったらアプリにコピーして、自分の旅に合わせて直せます。', day: '日目', days: '日間', copy: 'Tripfold にコピーする', getApp: 'App Store で入手', hotel: '宿を探す', do: 'ツアー・チケット', esim: '現地で使える eSIM', by: '作成', pr: '予約サイトへのリンクには提携リンクを含みます。', empty: 'まだ公開されたしおりはありません。アプリの共有画面から、あなたの旅を最初の1件として公開してみませんか。', report: '不適切な内容を報告', note: '作った人のひとこと', more: 'ほかのしおり', walk: '徒歩', car: '車・タクシー', min: '分', about: '目安', spots: 'か所', overview: 'この旅のあらまし', book: 'この旅の予約', credit: '写真・説明：Wikipedia', search: '都市名で探す（例：京都、London）', mapNote: '地図：© OpenStreetMap', type: { flight: '飛行機', train: '電車', bus: 'バス', hotel: '宿', car: 'レンタカー', ticket: 'チケット', food: '食事', plan: '観光', other: 'その他' } },
    en: { list: 'Trip plans by travellers', listSub: 'Real itineraries shared by people who took the trip — with photos, maps and travel times. Copy one into the app and make it yours.', day: 'Day ', days: ' days', copy: 'Copy to Tripfold', getApp: 'Get it on the App Store', hotel: 'Places to stay', do: 'Tours & tickets', esim: 'eSIM for the trip', by: 'by', pr: 'Some booking links are affiliate links.', empty: 'No shared plans yet. Publish your trip from the Share screen in the app.', report: 'Report this page', note: 'From the author', more: 'More plans', walk: 'Walk', car: 'Car / taxi', min: ' min', about: 'approx.', spots: ' spots', overview: 'Trip at a glance', book: 'Book this trip', credit: 'Photos & text: Wikipedia', search: 'Search by city', mapNote: 'Map © OpenStreetMap', type: { flight: 'Flight', train: 'Train', bus: 'Bus', hotel: 'Stay', car: 'Car', ticket: 'Ticket', food: 'Food', plan: 'Sight', other: 'Other' } },
  };
  const langOf = (req) => {
    const q = new URL(req.url, 'http://x').searchParams.get('lang');
    if (q === 'ja' || q === 'en') return q;
    const ck = (String(req.headers.cookie || '').match(/(?:^|;\s*)lang=(ja|en)/) || [])[1];
    return ck || (/^ja/i.test(String(req.headers['accept-language'] || '')) ? 'ja' : 'en');
  };
  const dayLabel = (w, n, L) => (L === 'ja' ? `${n}${w.day}` : `${w.day}${n}`);
  const ICON = { flight: '✈️', train: '🚆', bus: '🚌', hotel: '🛏️', car: '🚗', ticket: '🎟️', food: '🍽️', plan: '📍', other: '•' };
  const COLOR = { flight: '#4C7DF0', train: '#1E9E7A', bus: '#1E9E7A', hotel: '#7B61FF', car: '#4C7DF0', ticket: '#E8456B', food: '#D99A1E', plan: '#1C8FB0', other: '#8C9099' };
  const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0)));
  const ORIGIN = 'https://tripfold.net';
  const FALLBACK = ['/assets/london.jpg', '/assets/paris.jpg', '/assets/kyoto.jpg'];
  const pick = (id) => FALLBACK[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % FALLBACK.length];

  const CSS = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Segoe UI",sans-serif;color:#15171C;background:#F6F4EF;word-break:keep-all;overflow-wrap:anywhere;line-break:strict}
a{color:inherit}img{max-width:100%;display:block}.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.top{position:sticky;top:0;z-index:50;background:rgba(246,244,239,.9);backdrop-filter:saturate(180%) blur(14px);-webkit-backdrop-filter:saturate(180%) blur(14px);border-bottom:1px solid rgba(0,0,0,.06)}
.top .wrap{display:flex;align-items:center;gap:18px;height:60px}.logo{display:flex;align-items:center;gap:9px;text-decoration:none;font-weight:800;font-size:18px;letter-spacing:-.01em}.logo img{width:30px;height:30px;border-radius:8px}
.nav{display:flex;align-items:center;gap:18px;margin-left:auto;font-size:14px;font-weight:700;line-height:1}.nav a{display:inline-flex;align-items:center;height:36px}.lang{display:inline-flex;align-items:center;border:1px solid #DDD9D0;border-radius:999px;overflow:hidden;height:32px}.lang a{height:32px!important;padding:0 10px;font-size:12px;opacity:.6!important}.lang a.on{background:#15171C;color:#fff;opacity:1!important}.nav a{text-decoration:none;opacity:.75}.nav a:hover{opacity:1}.cta{background:#15171C;color:#fff!important;opacity:1!important;padding:0 16px;border-radius:999px}
@media(max-width:640px){.nav>a:not(.cta){display:none}}
.hero{position:relative;color:#fff;min-height:440px;display:flex;align-items:flex-end;background:#222 center/cover no-repeat}
.hero:before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.05) 0%,rgba(0,0,0,.15) 40%,rgba(0,0,0,.72) 100%)}
.hero .wrap{position:relative;padding-top:80px;padding-bottom:36px;width:100%}.hero h1{font-size:clamp(30px,5.4vw,52px);line-height:1.2;margin:10px 0 12px;letter-spacing:-.01em;text-shadow:0 2px 18px rgba(0,0,0,.3)}
.k{font-size:12px;letter-spacing:.16em;font-weight:800;text-transform:uppercase}.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.35);backdrop-filter:blur(6px);padding:5px 12px;border-radius:999px;font-size:14px;font-weight:700}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}.btn{display:inline-flex;align-items:center;gap:8px;background:#FF5B3A;color:#fff;text-decoration:none;font-weight:800;padding:13px 20px;border-radius:14px}.btn.w{background:#fff;color:#15171C}.btn.d{background:#15171C}
.meta{color:#8C9099;font-size:14px}h2{font-size:24px;line-height:1.35;margin:44px 0 14px;letter-spacing:-.01em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}.tile{display:block;background:#fff;border-radius:20px;overflow:hidden;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.05),0 8px 24px rgba(0,0,0,.05);transition:transform .2s}.tile:hover{transform:translateY(-3px)}
.tile .ph{aspect-ratio:4/3;background:#ddd center/cover no-repeat;position:relative}.tile .ph span{position:absolute;left:12px;top:12px;background:rgba(255,255,255,.92);color:#15171C;font-size:12px;font-weight:800;padding:3px 9px;border-radius:999px}
.tile .tx{padding:12px 16px 16px}.tile b{display:block;font-size:17px;line-height:1.4;margin-bottom:4px}
.card{background:#fff;border-radius:20px;padding:18px 20px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.over{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-top:-26px;position:relative;z-index:2}.over .card{padding:14px 16px}.over b{display:block;font-size:22px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:28px;align-items:start}@media(max-width:900px){.layout{grid-template-columns:1fr}}.side{position:sticky;top:76px}
.days{display:flex;gap:8px;overflow-x:auto;padding:4px 0 8px;margin-top:28px;position:sticky;top:60px;background:#F6F4EF;z-index:20}.days a{flex:none;text-decoration:none;font-weight:800;font-size:14px;padding:8px 14px;border-radius:999px;background:#fff;border:1px solid #E6E3DC}
.dayh{display:flex;align-items:baseline;gap:10px;margin:36px 0 12px}.dayh h2{margin:0}.map{height:300px;border-radius:20px;overflow:hidden;margin-bottom:16px;background:#E8E5DE}
.tl{position:relative}.stop{display:grid;grid-template-columns:56px minmax(0,1fr);gap:12px}.tm{font-weight:800;font-size:14px;padding-top:14px;text-align:right;color:#15171C}
.sc{background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.05);display:grid;grid-template-columns:minmax(0,1fr) 150px}.sc.noimg{grid-template-columns:1fr}@media(max-width:560px){.sc{grid-template-columns:1fr}.sc .im{order:-1;aspect-ratio:16/9}}
.sc .bd{padding:14px 16px}.sc .im{background:#ddd center/cover no-repeat;min-height:120px}.sc h3{margin:2px 0 4px;font-size:17px;line-height:1.45}.tag{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:800;padding:2px 9px;border-radius:999px;color:#fff}
.sc p{margin:6px 0 0;font-size:14px;color:#4A4E57;line-height:1.7}.src{font-size:11px;color:#A0A3AA;text-decoration:none}.bk{display:inline-block;margin-top:8px;font-size:13px;font-weight:800;color:#FF5B3A;text-decoration:none}
.leg{display:grid;grid-template-columns:56px minmax(0,1fr);gap:12px;margin:2px 0}.leg div:last-child{border-left:2px dashed #CFCBC2;margin-left:22px;padding:10px 0 10px 18px;font-size:13px;font-weight:700;color:#6B6F78}
.links a{display:inline-flex;align-items:center;gap:6px;background:#F6F4EF;border-radius:12px;padding:8px 12px;margin:4px 6px 4px 0;text-decoration:none;font-weight:800;font-size:14px}
.foot{margin-top:60px;background:#15171C;color:#C9CBD1;font-size:13px}.foot .wrap{padding:32px 20px 40px;display:flex;flex-wrap:wrap;gap:12px 22px}.foot a{color:#fff;text-decoration:none}
input.q{width:100%;font:16px inherit;padding:14px 16px;border:1px solid #E1DED6;border-radius:14px;background:#fff}`;

  const shell = (L, inner, idx = true, title = '', desc = '', canonical = '', image = '') =>
    `<!doctype html><html lang="${L}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">${canonical ? `<link rel="canonical" href="${ORIGIN}${canonical}">` : ''}${idx ? '' : '<meta name="robots" content="noindex">'}
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">${image ? `<meta property="og:image" content="${esc(image.startsWith('/') ? ORIGIN + image : image)}"><meta name="twitter:card" content="summary_large_image">` : ''}
<meta name="apple-itunes-app" content="app-id=6833397163"><link rel="icon" href="/assets/icon192.png"><style>${CSS}</style></head><body>
<header class="top"><div class="wrap"><a class="logo" href="/"><img src="/assets/icon192.png" alt="">Tripfold</a><nav class="nav"><a href="/t">${L === 'ja' ? 'みんなのしおり' : 'Trip plans'}</a><a href="/guides">${L === 'ja' ? '旅行ガイド' : 'Guides'}</a><span class="lang"><a href="?lang=ja" class="${L === 'ja' ? 'on' : ''}">日本語</a><a href="?lang=en" class="${L === 'en' ? 'on' : ''}">EN</a></span><a class="cta" href="${APP_STORE}">${L === 'ja' ? 'アプリを入手' : 'Get the app'}</a></nav></div></header>
${inner}
<footer class="foot"><div class="wrap"><span>© Tripfold</span><a href="/">${L === 'ja' ? 'トップ' : 'Home'}</a><a href="/t">${esc(W[L].list)}</a><a href="/guides">${L === 'ja' ? '旅行ガイド' : 'Guides'}</a><a href="/privacy">${L === 'ja' ? 'プライバシーポリシー' : 'Privacy'}</a><a href="/legal">特定商取引法に基づく表記</a><span>${esc(W[L].pr)}</span></div></footer></body></html>`;

  function page(res, status, { title, desc, canonical, L, body, index: idx = true, image }) {
    res.setHeader('Set-Cookie', `lang=${L}; Path=/; Max-Age=31536000; SameSite=Lax`);
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=60', Vary: 'Cookie, Accept-Language', ...(idx ? {} : { 'X-Robots-Tag': 'noindex' }) });
    res.end(shell(L, body, idx, title, desc, canonical, image));
  }

  const minTxt = (w, m) => (m >= 60 ? `${Math.floor(m / 60)}${w === W.ja ? '時間' : 'h '}${m % 60 ? (m % 60) + w.min : ''}` : `${m}${w.min}`);

  function tripBody(d, L, others) {
    const w = W[L];
    const t = d.trip;
    const en = d.enrich || { items: [], legs: {} };
    const heroImg = en.hero?.img || pick(d.id);
    const deep = `tripfold://pub?id=${d.id}`;
    const days = [...new Set(t.items.map((i) => i.day))].sort((a, b) => a - b);
    const spots = t.items.filter((i) => SPOT.includes(i.type)).length;
    const moveMin = Object.values(en.legs || {}).reduce((a, l) => a + (l.min || 0), 0);
    const maps = [];
    const dayHtml = days.map((n) => {
      const idxs = t.items.map((it, i) => [it, i]).filter(([it]) => it.day === n);
      const pts = idxs.map(([, i]) => en.items?.[i] ? { ...en.items[i], n: i } : null).filter(Boolean);
      const num = new Map(pts.map((p, k) => [p.n, k + 1])); // 地図の番号＝場所がわかった予定だけの通し番号
      if (pts.length) maps.push({ id: `m${n}`, pts: pts.map((p) => [p.lat, p.lng, num.get(p.n)]), lines: idxs.map(([, i]) => en.legs?.[i]?.line).filter(Boolean) });
      const rows = idxs.map(([it, i], k) => {
        const e = en.items?.[i];
        const lk = itemLink(it, d);
        const sub = it.from || it.to ? `<div class="meta">${esc([it.from, it.to].filter(Boolean).join(' → '))}</div>` : '';
        const leg = en.legs?.[i];
        const legHtml = leg ? `<div class="leg"><div></div><div>${leg.mode === 'foot' ? '🚶 ' + w.walk : '🚕 ' + w.car} ${leg.rough ? w.about + ' ' : ''}${minTxt(w, leg.min)}${leg.km ? ` · ${leg.km}km` : ''}</div></div>` : idxs[k + 1] ? '<div class="leg"><div></div><div style="padding:6px 0 6px 18px"></div></div>' : '';
        return `<div class="stop"><div class="tm">${esc(it.time || '')}</div><div class="sc${e?.img ? '' : ' noimg'}"><div class="bd"><span class="tag" style="background:${COLOR[it.type]}">${ICON[it.type]} ${esc(w.type[it.type])}</span><h3>${num.has(i) ? `<span style="color:#FF5B3A">${num.get(i)}.</span> ` : ''}${jp(it.title)}</h3>${sub}${e?.desc ? `<p>${jp(e.desc)}</p><a class="src" href="${esc(e.wu)}" rel="nofollow">${esc(w.credit)}</a>` : ''}${lk ? `<br><a class="bk" rel="sponsored nofollow" href="${esc(lk)}">${L === 'ja' ? 'チケット・ツアーを見る →' : 'See tickets & tours →'}</a>` : ''}</div>${e?.img ? `<div class="im" style="background-image:url('${esc(e.img)}')" role="img" aria-label="${esc(it.title)}"></div>` : ''}</div></div>${legHtml}`;
      }).join('');
      return `<section id="d${n}"><div class="dayh"><h2>${esc(dayLabel(w, n, L))}</h2><span class="meta">${idxs.length}${L === 'ja' ? '件の予定' : ' plans'}</span></div>${pts.length ? `<div class="map" id="m${n}"></div>` : ''}<div class="tl">${rows}</div></section>`;
    }).join('');
    const links = linksFor(d).map((g) => `<div class="card" style="margin-bottom:12px"><b>${esc(g.k === 'hotel' ? `${w.hotel}：${g.city}` : g.k === 'do' ? `${w.do}：${g.city}` : w.esim)}</b><div class="links">${g.links.map((l) => `<a rel="sponsored nofollow" href="${esc(l.u)}">${esc(l.n)} ↗</a>`).join('')}</div></div>`).join('');
    const leaflet = maps.length
      ? `<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>(function(){var M=${JSON.stringify(maps)};M.forEach(function(m){var el=document.getElementById(m.id);if(!el||!window.L)return;var map=L.map(el,{scrollWheelZoom:false,attributionControl:true});L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);var b=[];m.lines.forEach(function(l){if(l.length>1)L.polyline(l,{color:'#FF5B3A',weight:4,opacity:.8}).addTo(map)});var prev=null;m.pts.forEach(function(p){b.push([p[0],p[1]]);L.marker([p[0],p[1]],{icon:L.divIcon({className:'',html:'<div style="width:28px;height:28px;border-radius:50%;background:#FF5B3A;color:#fff;font:800 13px/28px -apple-system,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)">'+p[2]+'</div>',iconSize:[28,28],iconAnchor:[14,14]})}).addTo(map)});if(b.length===1)map.setView(b[0],15);else map.fitBounds(b,{padding:[34,34]})})})();</script>`
      : '';
    return `<section class="hero" style="background-image:url('${esc(heroImg)}')"><div class="wrap"><a href="/t" class="k" style="color:#fff;text-decoration:none">← ${esc(w.list)}</a>
<h1>${jp((t.emoji ? t.emoji + ' ' : '') + t.name)}</h1><div class="chips"><span class="chip">${esc(t.countries.map(flag).join(' '))} ${esc(t.days + w.days)}</span>${t.cities.slice(0, 4).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}${d.author ? `<span class="chip">${esc(w.by)} ${esc(d.author)}</span>` : ''}</div>
<div class="btns"><a class="btn" href="${deep}">${esc(w.copy)}</a><a class="btn w" href="${APP_STORE}">${esc(w.getApp)}</a></div></div></section>
<div class="wrap"><div class="over"><div class="card"><span class="meta">${L === 'ja' ? '日数' : 'Length'}</span><b>${esc(t.days + w.days)}</b></div><div class="card"><span class="meta">${L === 'ja' ? '行く場所' : 'Stops'}</span><b>${spots}${esc(w.spots)}</b></div>${moveMin ? `<div class="card"><span class="meta">${L === 'ja' ? '移動の合計（目安）' : 'Getting around'}</span><b>${esc(minTxt(w, moveMin))}</b></div>` : ''}<div class="card"><span class="meta">${L === 'ja' ? '国・都市' : 'Where'}</span><b>${esc(t.countries.map(flag).join(' ') || '—')}</b></div></div>
${t.note ? `<div class="card" style="margin-top:20px"><div class="k" style="color:#FF5B3A">${esc(w.note)}</div><p style="margin:6px 0 0">${jp(t.note).replace(/\n/g, '<br>')}</p></div>` : ''}
${en.hero?.desc ? `<div class="card" style="margin-top:16px"><div class="k" style="color:#8C9099">${esc(t.cities[0] || '')}</div><p style="margin:6px 0 4px">${jp(en.hero.desc)}</p><a class="src" href="${esc(en.hero.url)}" rel="nofollow">${esc(w.credit)}</a></div>` : ''}
<nav class="days">${days.map((n) => `<a href="#d${n}">${esc(dayLabel(w, n, L))}</a>`).join('')}</nav>
<div class="layout"><div>${dayHtml}<p class="meta" style="margin-top:14px">${maps.length ? esc(w.mapNote) + ' · ' : ''}${L === 'ja' ? '移動時間は地図上の道のりからの目安です。' : 'Travel times are estimates from map routes.'}</p></div>
<aside class="side"><h2 style="margin-top:36px">${esc(w.book)}</h2>${links}<a class="btn d" style="width:100%;justify-content:center" href="${deep}">${esc(w.copy)}</a></aside></div>
${others.length ? `<h2>${esc(w.more)}</h2><div class="grid">${others.map(tile(L)).join('')}</div>` : ''}
<p class="meta" style="margin-top:28px"><a href="mailto:info@anzenshorui.com?subject=${enc('Report /t/' + d.id)}">${esc(w.report)}</a></p></div>${leaflet}`;
  }
  const heroOf = (id) => {
    try {
      const d = JSON.parse(fs.readFileSync(file(id), 'utf8'));
      return d.enrich?.hero?.img || pick(id);
    } catch {
      return pick(id);
    }
  };
  const tile = (L) => (s) => `<a class="tile" href="/t/${s.id}"><div class="ph" style="background-image:url('${esc(s.img || heroOf(s.id))}')"><span>${esc(s.countries.map(flag).join(' '))} ${esc(s.days + W[L].days)}</span></div><div class="tx"><b>${jp((s.emoji ? s.emoji + ' ' : '') + s.name)}</b><span class="meta">${esc(s.cities.slice(0, 4).join(' · '))}</span></div></a>`;

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
      enrich(id);
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
        delete d.enrich;
        await writeJ(file(d.id), d);
        (await loadIndex()).set(d.id, summary(d));
        enrich(d.id);
        return send(res, 200, { ok: true, url: `${ORIGIN}/t/${d.id}` });
      }
    }
    // 一覧（JSON。トップページで使う）
    if (p === '/v1/pub' && req.method === 'GET') {
      const all = [...(await loadIndex()).values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
      return send(res, 200, { items: all.map((s) => ({ ...s, img: heroOf(s.id) })) });
    }
    // 一覧ページ
    if (p === '/t' && req.method === 'GET') {
      const L = langOf(req);
      const w = W[L];
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 40);
      let all = [...(await loadIndex()).values()].sort((a, b) => b.updatedAt - a.updatedAt);
      if (q) all = all.filter((s) => [s.name, ...s.cities].join(' ').toLowerCase().includes(q));
      const body = `<section class="hero" style="min-height:360px;background-image:url('/assets/paris.jpg')"><div class="wrap"><div class="k">TRIP PLANS</div><h1>${jp(w.list)}</h1><p style="max-width:640px;margin:0;font-size:16px;opacity:.95">${jp(w.listSub)}</p></div></section>
<div class="wrap"><form action="/t" style="margin:-26px 0 26px;position:relative;z-index:2"><input class="q" name="q" value="${esc(q)}" placeholder="${esc(w.search)}"></form>
${q ? `<p class="meta">${L === 'ja' ? `「${esc(q)}」の検索結果：${all.length}件` : `Results for “${esc(q)}”: ${all.length}`}</p>` : ''}${all.length ? `<div class="grid">${all.slice(0, 120).map(tile(L)).join('')}</div>` : `<div class="card">${q ? (L === 'ja' ? `「${esc(q)}」のしおりはまだありません。<a href="/t">すべてのしおり</a>や<a href="/guides">旅行ガイド</a>もご覧ください。` : `No plans for “${esc(q)}” yet. See <a href="/t">all plans</a> or <a href="/guides">guides</a>.`) : jp(w.empty)}</div>`}
<div class="btns" style="margin-top:30px"><a class="btn d" href="${APP_STORE}">${esc(w.getApp)}</a></div></div>`;
      return page(res, 200, { title: `${w.list} | Tripfold`, desc: w.listSub, canonical: '/t', L, body, index: !q, image: '/assets/paris.jpg' });
    }
    // 各しおりのページ
    m = p.match(/^\/t\/([a-z0-9]{10})$/);
    if (m && req.method === 'GET') {
      const L = langOf(req);
      const d = await readJ(file(m[1]));
      if (!d || d.hidden) return page(res, 404, { title: 'Tripfold', desc: '', L, body: `<div class="wrap" style="padding:60px 20px"><h1>${L === 'ja' ? 'このしおりは見つかりません' : 'Plan not found'}</h1><a class="btn" href="/t">${esc(W[L].list)}</a></div>`, index: false });
      if (!d.enrich && !running.has(d.id)) enrich(d.id);
      const idx = await loadIndex();
      const others = [...idx.values()].filter((s) => s.id !== d.id && s.cities.some((c) => d.trip.cities.includes(c))).slice(0, 6);
      const t = d.trip;
      const desc = `${t.cities.join('・')} ${t.days}${W[L].days}: ${t.items.slice(0, 6).map((i) => i.title).join(' / ')}`.slice(0, 160);
      return page(res, 200, { title: `${t.name} | ${W[L].list}`, desc, canonical: `/t/${d.id}`, L, body: tripBody(d, L, others), image: d.enrich?.hero?.img || pick(d.id) });
    }
    return false;
  };
};
