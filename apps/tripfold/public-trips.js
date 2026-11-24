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
  const summary = (d) => ({ id: d.id, name: d.trip.name, nameEn: d.trip.nameEn, emoji: d.trip.emoji, days: d.trip.days, cities: d.trip.cities, citiesJa: d.trip.citiesJa, countries: d.trip.countries, author: d.author, lang: d.lang, n: d.trip.items.length, updatedAt: d.updatedAt, official: !!d.official, theme: d.trip.theme, car: !!d.trip.car });
  // 公式しおりは日本語と英語の両方を持つ。画面の言語に合わせて出し分ける
  const nameOf = (t, L) => (L === 'en' && t.nameEn) || t.name;
  const citiesOf = (t, L) => (L === 'ja' && t.citiesJa?.length ? t.citiesJa : t.cities);
  const titleOf = (it, L) => (L === 'en' && it.en) || it.title;
  const noteOf = (t, L) => (L === 'en' && t.noteEn) || t.note;
  // SNSでそのまま送れる紹介文
  const snsText = (s, L) =>
    L === 'ja'
      ? `${nameOf(s, L)}｜地図と移動時間つきの無料しおりです。アプリにコピーして、そのまま自分の旅に使えます → ${ORIGIN}/t/${s.id}`
      : `${nameOf(s, L)} | a free trip plan with maps and travel times. Copy it into the app and make it yours → ${ORIGIN}/t/${s.id}`;
  // 旅のDNA（アプリの src/dna.ts と同じ表）
  const DNA_AXES = [['早起き', 'Early starts'], ['夜型', 'Night outs'], ['詰め込み', 'Packed days'], ['グルメ', 'Food'], ['名所', 'Sights'], ['体験', 'Experiences'], ['都市巡り', 'City hopping'], ['遠出', 'Long haul'], ['鉄道・バス', 'Rail & bus'], ['長旅', 'Long trips'], ['仲間旅', 'Group travel'], ['宿重視', 'Stays'], ['ご褒美', 'Splurge'], ['計画派', 'Planning ahead'], ['記録派', 'Journaling']];
  const DNA_K = ['early', 'night', 'packed', 'food', 'sights', 'exp', 'cities', 'far', 'rail', 'long', 'group', 'stay', 'spend', 'plan', 'memo'];
  const ADJ_HI = { early: ['早起きの', 'Early-rising'], night: ['夜を楽しむ', 'After-dark'], packed: ['欲張りな', 'Go-getting'], food: ['食いしん坊の', 'Hungry'], sights: ['名所好きの', 'Landmark-loving'], exp: ['体験重視の', 'Hands-on'], cities: ['都市を渡る', 'Roaming'], far: ['遠くへ飛ぶ', 'Far-flying'], rail: ['鉄道好きの', 'Rail-riding'], long: ['じっくり滞在する', 'Slow-travel'], group: ['みんなで楽しむ', 'Social'], stay: ['宿にこだわる', 'Stay-savvy'], spend: ['ご褒美派の', 'Treat-yourself'], plan: ['計画上手な', 'Well-planned'], memo: ['記録好きの', 'Story-keeping'] };
  const ADJ_LO = { packed: ['のんびり派の', 'Easy-going'], group: ['ひとり旅の', 'Solo'], spend: ['節約上手な', 'Thrifty'], plan: ['思い立ったら即の', 'Spontaneous'], early: ['朝はゆっくりの', 'Late-morning'] };
  const NOUN = { early: ['アーリーバード', 'Early Bird'], night: ['ナイトウォーカー', 'Night Walker'], packed: ['スケジュールマスター', 'Schedule Master'], food: ['グルメハンター', 'Food Hunter'], sights: ['名所コレクター', 'Landmark Collector'], exp: ['アドベンチャラー', 'Adventurer'], cities: ['シティホッパー', 'City Hopper'], far: ['ジェットセッター', 'Jet Setter'], rail: ['レイルトラベラー', 'Rail Traveller'], long: ['ノマド', 'Nomad'], group: ['旅のリーダー', 'Trip Leader'], stay: ['ホテルラバー', 'Hotel Lover'], spend: ['ラグジュアリー旅人', 'Luxe Traveller'], plan: ['トラベルプランナー', 'Trip Planner'], memo: ['ストーリーテラー', 'Storyteller'] };
  const dnaType = (v, ja) => {
    const order = DNA_K.map((k, i) => ({ k, d: v[i] - 50 })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    const nounK = order.find((x) => x.d > 0)?.k ?? 'sights';
    const second = order.find((x) => x.k !== nounK && (x.d > 0 ? ADJ_HI[x.k] : ADJ_LO[x.k]));
    const adj = second ? (second.d > 0 ? ADJ_HI[second.k] : ADJ_LO[second.k]) : null;
    return ja ? `${adj ? adj[0] : ''}${NOUN[nounK][0]}` : `${adj ? adj[1] + ' ' : ''}${NOUN[nounK][1]}`;
  };
  const THEME_NAME = { ja: { classic: '定番', packed: '詰め込み', art: '美術館', history: '歴史・建築', nature: '自然・公園', hidden: '穴場', castle: '古城ドライブ', scenic: '絶景ドライブ' }, en: { classic: 'Classics', packed: 'Packed', art: 'Art', history: 'History', nature: 'Nature', hidden: 'Hidden gems', castle: 'Castle drives', scenic: 'Scenic drives' } };

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
  const rakuten = (u) => `https://hb.afl.rakuten.co.jp/hgc/${RAKUTEN}/?pc=${enc(u)}&m=${enc(u)}`;
  const rkSearch = (q) => rakuten(`https://kw.travel.rakuten.co.jp/keyword/Search.do?charset=utf-8&f_query=${enc(q)}`);
  const gyg = (q, sub) => `https://www.getyourguide.com/s/?q=${enc(q)}&partner_id=${GYG}&cmp=${enc(sub)}`;
  // b＝クリックを数えるときのサイト名（stats.js の BRANDS と合わせる）
  function linksFor(d) {
    const sub = 't_' + d.id;
    const out = [];
    const jp = d.trip.countries.includes('JP');
    for (const c of d.trip.cities.slice(0, 3)) {
      out.push({ k: 'hotel', city: c, links: [
        ...(jp ? [{ n: '楽天トラベル', b: 'rakuten', u: rkSearch(c) }] : []),
        { n: 'Booking.com', b: 'booking', u: `https://www.booking.com/searchresults.html?ss=${enc(c)}` },
      ] });
      out.push({ k: 'do', city: c, links: [
        { n: 'Klook', b: 'klook', u: tp('klook', `https://www.klook.com/search/result/?query=${enc(c)}`, sub) },
        { n: 'KKday', b: 'kkday', u: tp('kkday', `https://www.kkday.com/en/product/productlist?keyword=${enc(c)}`, sub) },
        { n: 'GetYourGuide', b: 'gyg', u: gyg(c, sub) },
      ] });
    }
    if (d.trip.car) out.unshift({ k: 'rent', links: [{ n: 'Klook', b: 'klook', u: tp('klook', `https://www.klook.com/search/result/?query=${enc((d.trip.cities[0] || '') + ' car rental')}`, sub) }, ...(jp ? [{ n: '楽天トラベル', b: 'rakuten', u: rakuten('https://travel.rakuten.co.jp/cars/') }] : [])] });
    if (d.trip.countries.some((c) => c !== 'JP') || !jp) out.push({ k: 'esim', links: [{ n: 'Airalo', b: 'airalo', u: tp('airalo', 'https://www.airalo.com/', sub) }, { n: 'Klook eSIM', b: 'klook', u: tp('klook', 'https://www.klook.com/search/result/?query=eSIM', sub) }] });
    return out;
  }
  // 予定ひとつごとの予約リンク。観光・チケット＝Klook と GetYourGuide、宿（日本）＝楽天トラベルで宿の名前を検索
  const itemLinks = (it, d) => {
    const sub = 't_' + d.id;
    const q = [it.en || it.title, d.trip.cities[0]].filter(Boolean).join(' ');
    if (['ticket', 'plan'].includes(it.type)) return [{ n: 'Klook', b: 'klook', u: tp('klook', `https://www.klook.com/search/result/?query=${enc(q)}`, sub) }, { n: 'GetYourGuide', b: 'gyg', u: gyg(q, sub) }];
    if (it.type === 'hotel' && d.trip.countries.includes('JP')) return [{ n: '楽天トラベル', b: 'rakuten', u: rkSearch(it.title) }];
    return [];
  };
  const linkA = (l, cls = '') => `<a${cls ? ` class="${cls}"` : ''} rel="sponsored nofollow" data-b="${l.b}" href="${esc(l.u)}">${esc(l.n)} ↗</a>`;

  /* ---------- 写真・説明・道のり（公開したあとに、サーバーが少しずつ調べて付け足す） ---------- */
  // 場所：このサーバーの「場所探し」を使う／道のり：このサーバーの「道のり」を使う／写真と説明：Wikipedia
  const LOCAL = `http://127.0.0.1:${PORT}`;
  const UA = { 'User-Agent': 'Tripfold/1.0 (travel planner app; https://tripfold.net)' };
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
  async function wiki(q, lang, near, big, only) {
    for (const l of only ? [lang] : [lang, 'en']) {
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
        const g = await locate(`${it.en || it.title}${t.cities[0] ? ', ' + t.cities[0] : ''}`, center, d.official ? 'en' : L);
        if (d.official && g) {
          // 公式しおり：写真と英語の説明は英語版、日本語の説明は日本語版の Wikipedia から
          const we = await wiki(it.en || it.title, 'en', g, false, true);
          const wj = it.title !== it.en ? await wiki(it.title, 'ja', g, false, true) : null;
          items.push({ lat: g.lat, lng: g.lng, ...(we ? { img: we.img, desc: we.desc, wt: we.title, wu: we.url } : {}), ...(wj ? { img: we?.img || wj.img, dja: wj.desc, wuja: wj.url } : {}) });
          continue;
        }
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
      const hero = t.cities[0] ? await wiki(t.cities[0], d.official ? 'en' : L, center, true) : null;
      const heroJa = d.official && t.citiesJa?.[0] ? await wiki(t.citiesJa[0], 'ja', center, true, true) : null;
      const now = (await readJ(file(id))) || d;
      if (JSON.stringify(now.trip) !== JSON.stringify(t)) return; // 調べている間に直された
      now.enrich = { at: Date.now(), items, legs, hero: hero ? { img: hero.img, desc: hero.desc, title: hero.title, url: hero.url, ...(heroJa ? { dja: heroJa.desc, uja: heroJa.url } : {}) } : null };
      await writeJ(file(id), now);
    } catch {
    } finally {
      running.delete(id);
    }
  }

  /* ---------- 公式しおり（seed/*.json）：起動するたびに、なければ入れる・内容が変わっていれば入れ直す ---------- */
  // 1件の形：{ slug, cc, city:[英語,日本語], emoji, name:[日本語,英語], note:[日本語,英語], items:[[日,時刻,種類,日本語名,英語名,ひとこと日本語,ひとこと英語], …] }
  const SEED_DIR = path.join(__dirname, 'seed');
  const idOf = (slug) => Array.from(crypto.createHash('sha256').update('official:' + slug).digest().subarray(0, 10), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  async function seedOfficial() {
    let files = [];
    try {
      files = (await fsp.readdir(SEED_DIR)).filter((f) => /^\d.*\.json$/.test(f)).sort();
    } catch {
      return;
    }
    const todo = [];
    let n = 0;
    for (const f of files) {
      let plans = [];
      try {
        plans = JSON.parse(await fsp.readFile(path.join(SEED_DIR, f), 'utf8'));
      } catch (e) {
        console.error('seed', f, e.message);
        continue;
      }
      for (const pl of plans) {
        n++;
        const id = idOf(pl.slug);
        const hash = sha(JSON.stringify(pl)).slice(0, 16);
        const old = await readJ(file(id));
        if (old && old.seedHash === hash) {
          if (!old.enrich) todo.push(id);
          continue;
        }
        const trip = {
          name: pl.name[0], nameEn: pl.name[1], emoji: pl.emoji, days: Math.max(...pl.items.map((x) => x[0])),
          cities: [pl.city[0]], citiesJa: [pl.city[1]], countries: [pl.cc], note: pl.note?.[0], noteEn: pl.note?.[1],
          items: pl.items.map(([day, time, type, ja, en, tj, te]) => ({ type, title: ja, en, day, time: time || undefined, ...(tj || te ? { tip: { ja: tj, en: te } } : {}) })),
        };
        // 一覧で新しい順に並ぶので、作った時刻を少しずつずらす（ファイルの順＝一覧の上から下）
        const at = old?.createdAt || Date.UTC(2026, 10, 20) - n * 37 * 60 * 1000;
        const d = { id, official: true, seedHash: hash, author: 'Tripfold', lang: 'ja', trip, createdAt: at, updatedAt: at, ...(old?.enrich && JSON.stringify(old.trip.items.map((x) => x.en)) === JSON.stringify(trip.items.map((x) => x.en)) ? { enrich: old.enrich } : {}) };
        await writeJ(file(id), d);
        (await loadIndex()).set(id, summary(d));
        if (!d.enrich) todo.push(id);
      }
    }
    // 写真・道のりは1件ずつ順に調べる（地図の検索は1秒に1回までなので、まとめて走らせない）
    for (const id of todo) await enrich(id);
    if (todo.length) console.log('official plans enriched:', todo.length);
  }
  // 自動生成の公式しおり（gen-plans.js）。手書きの公式しおりを入れ終わってから動かす
  const gen = require('./gen-plans')({
    DATA,
    readJ,
    writeJ,
    onPlan: async (slug, trip, en, n) => {
      const id = idOf(slug);
      const old = await readJ(file(id));
      if (old && JSON.stringify(old.trip) === JSON.stringify(trip) && old.enrich && old.slug === slug) return;
      const at = old?.createdAt || Date.UTC(2026, 10, 10) - n * 7 * 60 * 1000;
      const d = { id, slug, official: true, gen: true, author: 'Tripfold', lang: 'ja', trip, enrich: en, createdAt: at, updatedAt: at };
      await writeJ(file(id), d);
      (await loadIndex()).set(id, summary(d));
    },
    // 今回作られなかった自動生成のしおり（条件に合わなくなったもの）は消す
    onFinish: async (made, failed) => {
      const keep = new Set([...made].map(idOf));
      const idx = await loadIndex();
      let n = 0;
      for (const [id, s0] of idx) {
        if (!s0.official || keep.has(id)) continue;
        const d = await readJ(file(id));
        if (!d?.gen) continue;
        // 取得に失敗した場所のしおりは残す（古いデータには slug が無いので、失敗が1件でもあれば slug 無しも残す）
        if (d.slug ? [...failed].some((f) => d.slug.startsWith(`g-${f}-`)) : failed.size) continue;
        await fsp.rm(file(id), { force: true });
        idx.delete(id);
        n++;
      }
      if (n) console.log('gen: removed stale', n);
    },
  });
  setTimeout(() => seedOfficial().catch((e) => console.error('seed', e)).then(() => gen.run()).catch((e) => console.error('gen', e)), 5000);

  /* ---------- 日本語の改行：助詞や「・」のあとで折り返す（単語の途中で切れないように） ---------- */
  // BudouX（Google の文節区切り）で、文節の切れ目にだけ改行の候補を入れる
  const budoux = (() => {
    try {
      const { Parser } = require('./vendor/budoux/parser.js');
      const { model } = require('./vendor/budoux/data/models/ja.js');
      return new Parser(model);
    } catch {
      return null;
    }
  })();
  const jp = (x) => {
    const t = String(x == null ? '' : x);
    if (!budoux || !/[\u3040-\u30ff\u4e00-\u9fff]/.test(t)) return esc(t);
    return budoux.parse(t).map(esc).join('<wbr>');
  };

  /* ---------- 画面の言葉 ---------- */
  const W = {
    ja: { list: 'みんなのしおり', listSub: '旅行した人やTripfold編集部が作った、そのまま使える旅程です。写真と地図付きで、移動時間まで分かります。気に入ったらアプリにコピーして、自分の旅に合わせて直せます。', day: '日目', days: '日間', copy: 'Tripfold にコピーする', getApp: 'App Store で入手', hotel: '宿を探す', do: 'ツアー・チケット', esim: '現地で使える eSIM', by: '作成', pr: '予約サイトへのリンクには提携リンクを含みます。', empty: 'まだ公開されたしおりはありません。アプリの共有画面から、あなたの旅を最初の1件として公開してみませんか。', report: '不適切な内容を報告', note: '作った人の一言', more: '他のしおり', walk: '徒歩', car: '車・タクシー', transit: '電車・バスなど', rent: 'レンタカーを探す', share: 'SNSで紹介する', copied: 'コピーしました', min: '分', about: '目安', spots: 'か所', overview: 'この旅の概要', book: 'この旅の予約', credit: '写真・説明：Wikipedia', search: '都市名で探す（例：京都、London）', mapNote: '地図：© OpenStreetMap', type: { flight: '飛行機', train: '電車', bus: 'バス', hotel: '宿', car: 'レンタカー', ticket: 'チケット', food: '食事', plan: '観光', other: 'その他' } },
    en: { list: 'Trip plans by travellers', listSub: 'Ready-to-use itineraries from travellers and the Tripfold team — with photos, maps and travel times. Copy one into the app and make it yours.', day: 'Day ', days: ' days', copy: 'Copy to Tripfold', getApp: 'Get it on the App Store', hotel: 'Places to stay', do: 'Tours & tickets', esim: 'eSIM for the trip', by: 'by', pr: 'Some booking links are affiliate links.', empty: 'No shared plans yet. Publish your trip from the Share screen in the app.', report: 'Report this page', note: 'From the author', more: 'More plans', walk: 'Walk', car: 'Car / taxi', transit: 'Public transport', rent: 'Rent a car', share: 'Share on social media', copied: 'Copied', min: ' min', about: 'approx.', spots: ' spots', overview: 'Trip at a glance', book: 'Book this trip', credit: 'Photos & text: Wikipedia', search: 'Search by city', mapNote: 'Map © OpenStreetMap', type: { flight: 'Flight', train: 'Train', bus: 'Bus', hotel: 'Stay', car: 'Car', ticket: 'Ticket', food: 'Food', plan: 'Sight', other: 'Other' } },
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

  const CSS = `.top .wrap{gap:10px}.logo,.nav a,.lang,.cta{white-space:nowrap;flex:none}.nav{flex-wrap:nowrap}@media(max-width:640px){.nav{gap:8px}.cta{padding:0 12px!important;font-size:13px}.logo{font-size:17px}}*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Segoe UI",sans-serif;color:#15171C;background:#F6F4EF;word-break:keep-all;overflow-wrap:anywhere;line-break:strict}
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
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}@media(max-width:560px){.grid{grid-template-columns:1fr 1fr;gap:12px}.tile b{font-size:14px;line-height:1.35}.tile .tx{padding:10px 12px 12px}.tile .meta{font-size:12px}.tile .ph span{font-size:11px;left:8px;top:8px}}.tile{display:block;background:#fff;border-radius:20px;overflow:hidden;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.05),0 8px 24px rgba(0,0,0,.05);transition:transform .2s}.tile:hover{transform:translateY(-3px)}
.tile .ph{aspect-ratio:4/3;background:#ddd center/cover no-repeat;position:relative}.tile .ph span{position:absolute;left:12px;top:12px;background:rgba(255,255,255,.92);color:#15171C;font-size:12px;font-weight:800;padding:3px 9px;border-radius:999px}
.tile .tx{padding:12px 16px 16px}.tile b{display:block;font-size:17px;line-height:1.4;margin-bottom:4px}
.card{background:#fff;border-radius:20px;padding:18px 20px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.over{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-top:-26px;position:relative;z-index:2}.over .card{padding:14px 16px}.over b{display:block;font-size:22px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:28px;align-items:start}@media(max-width:900px){.layout{grid-template-columns:1fr}}.side{position:sticky;top:76px}
.days{display:flex;gap:8px;overflow-x:auto;padding:4px 0 8px;margin-top:28px;position:sticky;top:60px;background:#F6F4EF;z-index:20}.days a{flex:none;text-decoration:none;font-weight:800;font-size:14px;padding:8px 14px;border-radius:999px;background:#fff;border:1px solid #E6E3DC}
.dayh{display:flex;align-items:baseline;gap:10px;margin:36px 0 12px}.dayh h2{margin:0}.map{height:300px;border-radius:20px;overflow:hidden;margin-bottom:16px;background:#E8E5DE;position:relative;z-index:0;isolation:isolate}
.tl{position:relative}.stop{display:grid;grid-template-columns:56px minmax(0,1fr);gap:12px}.tm{font-weight:800;font-size:14px;padding-top:14px;text-align:right;color:#15171C}
.sc{background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.05);display:grid;grid-template-columns:minmax(0,1fr) 150px}.sc.noimg{grid-template-columns:1fr}@media(max-width:560px){.sc{grid-template-columns:1fr}.sc .im{order:-1;aspect-ratio:16/9}}
.sc .bd{padding:14px 16px}.sc .im{background:#ddd center/cover no-repeat;min-height:120px}.sc h3{margin:2px 0 4px;font-size:17px;line-height:1.45}.tag{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:800;padding:2px 9px;border-radius:999px;color:#fff}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px}.fchip{background:#fff;border:1px solid #E2DED6;border-radius:999px;padding:7px 14px;font-size:14px;font-weight:700;color:#15171C;text-decoration:none;white-space:nowrap}.fchip.on{background:#15171C;color:#fff;border-color:#15171C}.qform{display:flex;gap:8px}.qform .q{flex:1}.qbtn{border:0;border-radius:16px;background:#FF5B3A;color:#fff;font-weight:800;font-size:16px;padding:0 22px;cursor:pointer}.share{background:#fff;border:1px solid #E2DED6;border-radius:14px;padding:12px 14px;font-size:14px;margin-top:14px}.share button{margin-top:8px;border:0;border-radius:10px;background:#15171C;color:#fff;font-weight:800;padding:8px 14px;cursor:pointer}
.sc p.tip{color:#15171C;background:#FFF4EF;border-radius:10px;padding:8px 10px;margin-top:8px}.sc p{margin:6px 0 0;font-size:14px;color:#4A4E57;line-height:1.7}.src{font-size:11px;color:#A0A3AA;text-decoration:none}.bk{display:inline-block;margin-top:8px;font-size:13px;font-weight:800;color:#FF5B3A;text-decoration:none}
.leg{display:grid;grid-template-columns:56px minmax(0,1fr);gap:12px;margin:2px 0}.leg div:last-child{border-left:2px dashed #CFCBC2;margin-left:22px;padding:10px 0 10px 18px;font-size:13px;font-weight:700;color:#6B6F78}
.mob{display:none;margin:20px 0 0}@media(max-width:900px){.mob{display:block}}.bks{margin-top:8px;font-size:13px;font-weight:800;color:#6B6F78}.bks .bk{margin:0 6px 0 0}
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
        const lks = itemLinks(it, d);
        const dsc = L === 'ja' && e?.dja ? e.dja : d.official && L === 'ja' ? '' : e?.desc;
        const dsu = L === 'ja' && e?.dja ? e.wuja : e?.wu;
        const tip = it.tip ? (L === 'en' ? it.tip.en : it.tip.ja) : '';
        const sub = it.from || it.to ? `<div class="meta">${esc([it.from, it.to].filter(Boolean).join(' → '))}</div>` : '';
        const leg = en.legs?.[i];
        const legHtml = leg ? `<div class="leg"><div></div><div>${leg.mode === 'foot' ? '🚶 ' + w.walk : leg.mode === 'transit' ? '🚇 ' + w.transit : '🚗 ' + w.car} ${leg.rough ? w.about + ' ' : ''}${minTxt(w, leg.min)}${leg.km ? ` · ${leg.km}km` : ''}</div></div>` : idxs[k + 1] ? '<div class="leg"><div></div><div style="padding:6px 0 6px 18px"></div></div>' : '';
        return `<div class="stop"><div class="tm">${esc(it.time || '')}</div><div class="sc${e?.img ? '' : ' noimg'}"><div class="bd"><span class="tag" style="background:${COLOR[it.type]}">${ICON[it.type]} ${esc(w.type[it.type])}</span><h3>${num.has(i) ? `<span style="color:#FF5B3A">${num.get(i)}.</span> ` : ''}${jp(titleOf(it, L))}</h3>${sub}${tip ? `<p class="tip">${jp(tip)}</p>` : ''}${dsc ? `<p>${jp(dsc)}</p><a class="src" href="${esc(dsu)}" rel="nofollow">${esc(w.credit)}</a>` : ''}${lks.length ? `<div class="bks">${esc(it.type === 'hotel' ? (L === 'ja' ? '空室を見る' : 'Check rooms') : L === 'ja' ? 'チケット・ツアー' : 'Tickets & tours')}：${lks.map((l) => linkA(l, 'bk')).join(' ')}</div>` : ''}</div>${e?.img ? `<div class="im" style="background-image:url('${esc(e.img)}')" role="img" aria-label="${esc(titleOf(it, L))}"></div>` : ''}</div></div>${legHtml}`;
      }).join('');
      return `<section id="d${n}"><div class="dayh"><h2>${esc(dayLabel(w, n, L))}</h2><span class="meta">${idxs.length}${L === 'ja' ? '件の予定' : ' plans'}</span></div>${pts.length ? `<div class="map" id="m${n}"></div>` : ''}<div class="tl">${rows}</div></section>`;
    }).join('');
    const groups = linksFor(d);
    // スマホでは右側の「この旅の予約」がページの一番下になるので、1日目のあとにも最初の都市の宿・ツアーを出す
    const mob = groups.filter((g) => (g.k === 'hotel' || g.k === 'do') && g.city === t.cities[0]);
    const mobHtml = mob.length ? `<div class="card mob"><div class="k" style="color:#FF5B3A">${esc(w.book)}</div>${mob.map((g) => `<div style="margin-top:6px"><b style="font-size:14px">${esc(g.k === 'hotel' ? w.hotel : w.do)}</b><div class="links">${g.links.map((l) => linkA(l)).join('')}</div></div>`).join('')}</div>` : '';
    const dayHtml2 = dayHtml.replace('</section>', '</section>' + mobHtml);
    const links = groups.map((g) => `<div class="card" style="margin-bottom:12px"><b>${esc(g.k === 'hotel' ? `${w.hotel}：${g.city}` : g.k === 'do' ? `${w.do}：${g.city}` : g.k === 'rent' ? w.rent : w.esim)}</b><div class="links">${g.links.map((l) => linkA(l)).join('')}</div></div>`).join('');
    const leaflet = maps.length
      ? `<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>(function(){var M=${JSON.stringify(maps)};M.forEach(function(m){var el=document.getElementById(m.id);if(!el||!window.L)return;var map=L.map(el,{scrollWheelZoom:false,attributionControl:true});L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);var b=[];m.lines.forEach(function(l){if(l.length>1)L.polyline(l,{color:'#FF5B3A',weight:4,opacity:.8}).addTo(map)});var prev=null;m.pts.forEach(function(p){b.push([p[0],p[1]]);L.marker([p[0],p[1]],{icon:L.divIcon({className:'',html:'<div style="width:28px;height:28px;border-radius:50%;background:#FF5B3A;color:#fff;font:800 13px/28px -apple-system,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)">'+p[2]+'</div>',iconSize:[28,28],iconAnchor:[14,14]})}).addTo(map)});if(b.length===1)map.setView(b[0],15);else map.fitBounds(b,{padding:[34,34]})})})();</script>`
      : '';
    return `<section class="hero" style="background-image:url('${esc(heroImg)}')"><div class="wrap"><a href="/t" class="k" style="color:#fff;text-decoration:none">← ${esc(w.list)}</a>
<h1>${jp((t.emoji ? t.emoji + ' ' : '') + nameOf(t, L))}</h1><div class="chips"><span class="chip">${esc(t.countries.map(flag).join(' '))} ${esc(t.days + w.days)}</span>${citiesOf(t, L).slice(0, 4).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}${d.author ? `<span class="chip">${esc(w.by)} ${esc(d.author)}</span>` : ''}</div>
<div class="btns"><a class="btn" href="${deep}">${esc(w.copy)}</a><a class="btn w" href="/press/${d.id}">${L === 'ja' ? '📖 旅の雑誌にする' : '📖 Make it a magazine'}</a><a class="btn w" href="${APP_STORE}">${esc(w.getApp)}</a></div></div></section>
<div class="wrap"><div class="over"><div class="card"><span class="meta">${L === 'ja' ? '日数' : 'Length'}</span><b>${esc(t.days + w.days)}</b></div><div class="card"><span class="meta">${L === 'ja' ? '行く場所' : 'Stops'}</span><b>${spots}${esc(w.spots)}</b></div>${moveMin ? `<div class="card"><span class="meta">${L === 'ja' ? '移動の合計（目安）' : 'Getting around'}</span><b>${esc(minTxt(w, moveMin))}</b></div>` : ''}<div class="card"><span class="meta">${L === 'ja' ? '国・都市' : 'Where'}</span><b>${esc(t.countries.map(flag).join(' ') || '—')}</b></div></div>
${noteOf(t, L) ? `<div class="card" style="margin-top:20px"><div class="k" style="color:#FF5B3A">${esc(d.official ? (L === 'ja' ? 'この旅のポイント' : 'About this plan') : w.note)}</div><p style="margin:6px 0 0">${jp(noteOf(t, L)).replace(/\n/g, '<br>')}</p></div>` : ''}
${(() => { const hd = L === 'ja' && en.hero?.dja ? en.hero.dja : d.official && L === 'ja' ? '' : en.hero?.desc; return hd ? `<div class="card" style="margin-top:16px"><div class="k" style="color:#8C9099">${esc(citiesOf(t, L)[0] || '')}</div><p style="margin:6px 0 4px">${jp(hd)}</p><a class="src" href="${esc(L === 'ja' && en.hero?.dja ? en.hero.uja : en.hero.url)}" rel="nofollow">${esc(w.credit)}</a></div>` : ''; })()}
<nav class="days">${days.map((n) => `<a href="#d${n}">${esc(dayLabel(w, n, L))}</a>`).join('')}</nav>
<div class="layout"><div>${dayHtml2}<p class="meta" style="margin-top:14px">${maps.length ? esc(w.mapNote) + ' · ' : ''}${L === 'ja' ? '移動時間は地図上の道のりからの目安です。' : 'Travel times are estimates from map routes.'}</p></div>
<aside class="side"><h2 style="margin-top:36px">${esc(w.book)}</h2>${links}<a class="btn d" style="width:100%;justify-content:center" href="${deep}">${esc(w.copy)}</a><div class="share"><b>${esc(w.share)}</b><p id="snsText" style="margin:6px 0 0">${esc(snsText({ ...summary(d), id: d.id }, L))}</p><button onclick="var t=document.getElementById('snsText').textContent;if(navigator.share){navigator.share({text:t}).catch(function(){})}else{navigator.clipboard.writeText(t);this.textContent='${esc(w.copied)}'}">${esc(w.share)}</button></div></aside></div>
${others.length ? `<h2>${esc(w.more)}</h2><div class="grid">${others.map(tile(L)).join('')}</div>` : ''}
<p class="meta" style="margin-top:28px"><a href="mailto:info@anzenshorui.com?subject=${enc('Report /t/' + d.id)}">${esc(w.report)}</a></p></div>${leaflet}
<script>document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-b]');if(a&&navigator.sendBeacon)navigator.sendBeacon('/v1/c',a.getAttribute('data-b')+'|${d.id}')});</script>`;
  }
  /* ---------- 旅の雑誌（TRAVEL PRESS）：しおりを、印刷できる自分専用の旅行雑誌にする ---------- */
  //  - 表紙・目次・日ごとの扉・見どころ・思い出のページ。A5（148×210mm）で印刷・PDF保存できる
  //  - 自分の写真と文章は、この端末のブラウザの中だけに保存する（サーバーには送らない）
  const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  const COUNTRY_EN = { JP: 'JAPAN', GB: 'THE UK', FR: 'FRANCE', IT: 'ITALY', ES: 'SPAIN', DE: 'GERMANY', US: 'THE USA', KR: 'KOREA', TW: 'TAIWAN', TH: 'THAILAND', CN: 'CHINA', NL: 'THE NETHERLANDS', PT: 'PORTUGAL', AT: 'AUSTRIA', CZ: 'CZECHIA', GR: 'GREECE', TR: 'TÜRKIYE', SG: 'SINGAPORE', VN: 'VIETNAM', AU: 'AUSTRALIA', CA: 'CANADA', HK: 'HONG KONG', CH: 'SWITZERLAND', BE: 'BELGIUM', IE: 'IRELAND' };
  const cut = (x, n) => {
    const s = String(x || '');
    if (s.length <= n) return s;
    const c = s.slice(0, n);
    const dot = Math.max(c.lastIndexOf('。'), c.lastIndexOf('. '));
    return dot > n * 0.5 ? c.slice(0, dot + 1) : c + '…';
  };
  function pressPage(d, L) {
    const t = d.trip;
    const en = d.enrich || { items: [], legs: {} };
    const ja = L === 'ja';
    const cityEn = (t.cities[0] || t.nameEn || t.name || '').toUpperCase();
    const where = t.countries.length === 1 && COUNTRY_EN[t.countries[0]] ? COUNTRY_EN[t.countries[0]] : (t.cities[0] || '').toUpperCase();
    const now = new Date();
    const issue = `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
    const hero = en.hero?.img || pick(d.id);
    const days = [...new Set(t.items.map((i) => i.day))].sort((a, b) => a - b);
    const pad = (n) => String(n).padStart(2, '0');
    const credit = (img) => (img && /wikimedia|wikipedia/.test(img) ? `<span class="cr">${ja ? '写真：Wikipedia／Wikimedia Commons' : 'Photo: Wikipedia / Wikimedia Commons'}</span>` : '');
    const foot = (n) => `<div class="pf"><span>${esc(cityEn)} · TRIPFOLD PRESS</span><span>${pad(n)}</span></div>`;
    let pn = 1;
    const pages = [];
    // 表紙
    pages.push(`<section class="pg cover"><img class="bg" src="${esc(hero)}" alt=""><div class="shade"></div>
<div class="mast"><span>TRIPFOLD PRESS</span><span>PRIVATE TRAVEL EDITION</span></div>
<div class="cv"><div class="kick" data-k="kick" contenteditable="true">${esc(t.days)} DAYS IN ${esc(where)}</div><h1 data-k="title" contenteditable="true">${esc(cityEn)}</h1>
<p class="sub" data-k="sub" contenteditable="true">${jp(nameOf(t, L))}</p><div class="iss"><span data-k="issue" contenteditable="true">${esc(issue)}</span><span data-k="editor" contenteditable="true">${ja ? '編集・旅人：あなたの名前' : 'EDITED BY YOU'}</span></div></div>${credit(en.hero?.img)}</section>`);
    // 目次
    const intro = noteOf(t, L) || (ja && en.hero?.dja ? en.hero.dja : en.hero?.desc) || '';
    pages.push(`<section class="pg"><div class="k">CONTENTS</div><h2 class="big">${ja ? 'この号の中身' : 'In this issue'}</h2>
${intro ? `<p class="lede">${jp(cut(intro, 260))}</p>` : ''}
<ol class="toc">${days.map((n) => { const its = t.items.filter((i) => i.day === n && SPOT.includes(i.type)).slice(0, 3); return `<li><b>DAY ${pad(n)}</b><span>${its.map((i) => jp(titleOf(i, L))).join(' · ') || '—'}</span></li>`; }).join('')}<li><b>MEMORIES</b><span>${ja ? '旅の写真と記録' : 'Your photos and notes'}</span></li></ol>
<div class="note"><div class="k">${ja ? '編集後記' : "EDITOR'S LETTER"}</div><div class="lines" data-k="letter" contenteditable="true"></div></div>${foot(++pn)}</section>`);
    for (const n of days) {
      const idxs = t.items.map((it, i) => [it, i]).filter(([it]) => it.day === n);
      const feats = idxs.filter(([it, i]) => SPOT.includes(it.type) && it.type !== 'hotel' && (en.items?.[i]?.img || en.items?.[i]?.desc || en.items?.[i]?.dja || it.tip));
      const lead = feats.find(([, i]) => en.items?.[i]?.img);
      const leadImg = lead ? en.items[lead[1]].img : hero;
      // 日ごとの扉
      pages.push(`<section class="pg opener"><div class="dn">DAY<b>${pad(n)}</b></div><div class="oimg"><img src="${esc(leadImg)}" alt="">${credit(leadImg)}</div>
<ul class="sched">${idxs.map(([it]) => `<li><time>${esc(it.time || '')}</time><span>${jp(titleOf(it, L))}</span></li>`).join('')}</ul>${foot(++pn)}</section>`);
      // 見どころ（1ページに2つ）
      for (let k = 0; k < feats.length; k += 2) {
        const block = feats.slice(k, k + 2).map(([it, i]) => {
          const e = en.items?.[i] || {};
          const dsc = ja && e.dja ? e.dja : d.official && ja ? '' : e.desc;
          const tip = it.tip ? (ja ? it.tip.ja : it.tip.en) : '';
          return `<article class="ft">${e.img ? `<div class="fimg"><img src="${esc(e.img)}" alt="" loading="lazy">${credit(e.img)}</div>` : ''}<div class="fk">${esc(it.time || '')} · ${esc(W[L].type[it.type])}</div><h3>${jp(titleOf(it, L))}</h3>${tip ? `<p class="tip">${jp(tip)}</p>` : ''}${dsc ? `<p>${jp(cut(dsc, e.img ? 210 : 420))}</p>` : ''}</article>`;
        }).join('');
        pages.push(`<section class="pg"><div class="k">DAY ${pad(n)} — ${ja ? '見どころ' : 'HIGHLIGHTS'}</div><div class="fts">${block}</div>${foot(++pn)}</section>`);
      }
      // 思い出（旅行のあとに写真を入れる）
      pages.push(`<section class="pg mem"><div class="k">DAY ${pad(n)} — MEMORIES</div><div class="ph4">${[0, 1, 2].map((s) => `<label class="slot${s === 0 ? ' wide' : ''}" data-slot="d${n}-${s}"><img alt=""><span>${ja ? '＋ 写真を入れる' : '+ Add a photo'}</span><input type="file" accept="image/*" hidden></label>`).join('')}</div>
<div class="lines" data-k="memo${n}" contenteditable="true"></div>${foot(++pn)}</section>`);
    }
    // 裏表紙
    pages.push(`<section class="pg back"><div><div class="k">TRIPFOLD PRESS</div><p class="lede">${ja ? 'この雑誌は、Tripfold のしおりから作りました。' : 'This magazine was made from a Tripfold trip plan.'}</p><p class="url">tripfold.net/t/${esc(d.id)}</p></div></section>`);

    const T = ja
      ? { back: '← しおりに戻る', theme: 'デザイン', print: '印刷・PDFで保存', hint: '表紙や文章は押すと書き換えられます。「写真を入れる」から自分の写真も入れられます。写真と文章はこの端末の中だけに保存されます。', tips: '印刷の画面で「PDFに保存」を選ぶとPDFになります。用紙はA5、余白は「なし」、「背景のグラフィック」をオンにしてください。', reset: '書き換えを元に戻す' }
      : { back: '← Back to the plan', theme: 'Design', print: 'Print / Save as PDF', hint: 'Tap the cover and text to edit. Add your own photos to the memory pages. Photos and text stay on this device only.', tips: 'In the print dialog choose “Save as PDF”. Paper A5, margins “None”, and turn on “Background graphics”.', reset: 'Reset my edits' };
    return `<!doctype html><html lang="${L}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(nameOf(t, L))} — TRIPFOLD PRESS</title><link rel="icon" href="/assets/icon192.png"><style>
:root{--w:min(148mm,calc(100vw - 24px));--paper:#F4EFE6;--ink:#191714;--acc:#B5452F;--mute:#7A7268}
[data-theme=noir]{--paper:#141414;--ink:#F1ECE3;--acc:#E2C16B;--mute:#9C968C}[data-theme=mint]{--paper:#EDF2EC;--ink:#18332B;--acc:#2E7D5B;--mute:#6C7F77}
*{box-sizing:border-box}body{margin:0;background:#D9D4CB;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic",sans-serif;color:var(--ink);word-break:keep-all;overflow-wrap:anywhere;line-break:strict;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bar{position:sticky;top:0;z-index:9;background:#15171C;color:#fff;font-size:14px}.bar .in{max-width:900px;margin:0 auto;padding:10px 14px;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}.bar a{color:#fff;text-decoration:none;font-weight:700}.bar button,.bar select{font:inherit;font-weight:800;border:0;border-radius:10px;padding:8px 14px;cursor:pointer}.bar .pr{background:#FF5B3A;color:#fff;margin-left:auto}.bar select{background:#2A2D34;color:#fff}.hint{max-width:900px;margin:10px auto 0;padding:0 14px;font-size:13px;color:#4A4E57;line-height:1.7}.hint button{background:none;border:0;color:#B5452F;font:inherit;font-weight:700;cursor:pointer;padding:0}
.book{display:flex;flex-direction:column;align-items:center;gap:18px;padding:18px 0 60px}
.pg{width:var(--w);height:calc(var(--w)*1.4189);background:var(--paper);position:relative;overflow:hidden;padding:calc(var(--w)*.075) calc(var(--w)*.07) calc(var(--w)*.1);font-size:calc(var(--w)/36);line-height:1.75;box-shadow:0 2px 14px rgba(0,0,0,.18)}
.k{font-size:.72em;letter-spacing:.22em;font-weight:800;color:var(--acc);text-transform:uppercase}
.big,h1,h3,.dn b,.sched span,.toc b{font-family:"Hiragino Mincho ProN","Yu Mincho","YuMincho",Georgia,"Times New Roman",serif}
.big{font-size:2.3em;line-height:1.15;margin:.3em 0 .5em;font-weight:600}.lede{font-size:1.08em;line-height:1.85}
.cover{padding:0;color:#fff}.cover .bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.45) 0,rgba(0,0,0,0) 28%,rgba(0,0,0,0) 50%,rgba(0,0,0,.78) 100%)}
.mast{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;padding:1.6em 1.8em;font-size:.78em;font-weight:800;letter-spacing:.24em}
.cv{position:absolute;left:1.8em;right:1.8em;bottom:1.8em}.kick{font-size:.8em;letter-spacing:.24em;font-weight:800}.cover h1{font-size:3.9em;line-height:.95;margin:.12em 0 .18em;font-weight:600;letter-spacing:.01em;overflow-wrap:break-word}
.cover .sub{font-size:1.12em;margin:0 0 1em;max-width:22em}.iss{display:flex;justify-content:space-between;gap:1em;border-top:1px solid rgba(255,255,255,.6);padding-top:.7em;font-size:.74em;letter-spacing:.16em;font-weight:700}
.cr{position:absolute;right:.6em;bottom:.4em;font-size:.5em;color:rgba(255,255,255,.85);text-shadow:0 0 3px rgba(0,0,0,.6);letter-spacing:0;font-weight:400}.cover .cr{bottom:.5em}
.toc{list-style:none;padding:0;margin:1em 0}.toc li{display:grid;grid-template-columns:6.5em 1fr;gap:.8em;padding:.6em 0;border-bottom:1px solid color-mix(in srgb,var(--ink) 18%,transparent)}.toc b{font-size:1.05em}.toc span{font-size:.92em}
.note{margin-top:1.2em}.lines{min-height:7.2em;margin-top:.4em;outline:none;line-height:2.4em;background:repeating-linear-gradient(transparent 0,transparent calc(2.4em - 1px),color-mix(in srgb,var(--ink) 22%,transparent) calc(2.4em - 1px),color-mix(in srgb,var(--ink) 22%,transparent) 2.4em)}
.opener{display:flex;flex-direction:column}.dn{font-size:.95em;letter-spacing:.3em;font-weight:800;color:var(--acc)}.dn b{display:block;font-size:6.2em;line-height:.9;letter-spacing:0;color:var(--ink);font-weight:500}
.oimg{position:relative;height:38%;margin:.8em 0 1em;flex:none}.oimg img,.fimg img{width:100%;height:100%;object-fit:cover;display:block}
.sched{list-style:none;padding:0;margin:0;columns:1}.sched li{display:grid;grid-template-columns:3.6em 1fr;gap:.6em;padding:.3em 0;border-bottom:1px dotted color-mix(in srgb,var(--ink) 25%,transparent);font-size:.95em}.sched time{font-weight:800;color:var(--acc);font-size:.9em}
.fts{display:grid;grid-template-rows:1fr 1fr;gap:1.1em;height:calc(100% - 1.5em);margin-top:.6em}.ft{overflow:hidden;display:flex;flex-direction:column}.fimg{position:relative;height:42%;flex:none;margin-bottom:.5em}.fk{font-size:.7em;letter-spacing:.16em;font-weight:800;color:var(--mute)}.ft h3{font-size:1.5em;line-height:1.3;margin:.1em 0 .25em;font-weight:600}.ft p{margin:0 0 .4em;font-size:.9em}.ft .tip{border-left:3px solid var(--acc);padding-left:.6em}
.mem .ph4{display:grid;grid-template-columns:1fr 1fr;gap:.6em;height:56%;margin:.6em 0 .8em}.slot{position:relative;border:1.5px dashed color-mix(in srgb,var(--ink) 35%,transparent);display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;font-size:.85em;color:var(--mute);font-weight:700}.slot.wide{grid-column:1/3}.slot img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none}.slot.has img{display:block}.slot.has span{display:none}.slot.has{border:0}
.mem .lines{min-height:9.6em}
.back{display:flex;align-items:flex-end;background:var(--ink);color:var(--paper)}.back .k{color:var(--acc)}.url{font-weight:800;letter-spacing:.06em}
.pf{position:absolute;left:calc(var(--w)*.07);right:calc(var(--w)*.07);bottom:calc(var(--w)*.04);display:flex;justify-content:space-between;font-size:.62em;letter-spacing:.2em;color:var(--mute);font-weight:700}
[contenteditable]{outline:none}[contenteditable]:focus{box-shadow:0 0 0 2px color-mix(in srgb,var(--acc) 60%,transparent);border-radius:3px}
@page{size:148mm 210mm;margin:0}
@media print{:root{--w:148mm}body{background:none}.bar,.hint{display:none}.book{display:block;padding:0}.pg{box-shadow:none;break-after:page;page-break-after:always}.slot:not(.has){border-color:color-mix(in srgb,var(--ink) 15%,transparent)}.slot:not(.has) span{visibility:hidden}[contenteditable]:focus{box-shadow:none}}
</style></head><body data-theme="classic">
<div class="bar"><div class="in"><a href="/t/${esc(d.id)}">${esc(T.back)}</a><label>${esc(T.theme)} <select id="th"><option value="classic">Classic</option><option value="noir">Noir</option><option value="mint">Mint</option></select></label><button class="pr" onclick="window.print()">${esc(T.print)}</button></div></div>
<p class="hint">${esc(T.hint)}<br>${esc(T.tips)} <button id="rs">${esc(T.reset)}</button></p>
<div class="book">${pages.join('\n')}</div>
<script>(function(){var ID=${JSON.stringify(d.id)},K='press:'+ID,st={};try{st=JSON.parse(localStorage.getItem(K)||'{}')}catch(e){}
function save(){try{localStorage.setItem(K,JSON.stringify(st))}catch(e){}}
var th=document.getElementById('th');if(st.theme){document.body.dataset.theme=st.theme;th.value=st.theme}th.onchange=function(){document.body.dataset.theme=th.value;st.theme=th.value;save()};
document.querySelectorAll('[data-k]').forEach(function(el){var k=el.dataset.k;if(st[k]!=null)el.innerText=st[k];el.addEventListener('input',function(){st[k]=el.innerText;save()})});
document.getElementById('rs').onclick=function(){if(!window.confirm||confirm('OK?')){localStorage.removeItem(K);indexedDB.deleteDatabase('press-'+ID);location.reload()}};
var db=null,rq=indexedDB.open('press-'+ID,1);rq.onupgradeneeded=function(){rq.result.createObjectStore('p')};rq.onsuccess=function(){db=rq.result;document.querySelectorAll('.slot').forEach(function(s){var g=db.transaction('p').objectStore('p').get(s.dataset.slot);g.onsuccess=function(){if(g.result)show(s,g.result)}})};
function show(s,blob){var im=s.querySelector('img');im.src=URL.createObjectURL(blob);s.classList.add('has')}
document.querySelectorAll('.slot input').forEach(function(inp){inp.onchange=function(){var f=inp.files[0],s=inp.closest('.slot');if(!f)return;var img=new Image();img.onload=function(){var m=1800,r=Math.min(1,m/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=Math.round(img.width*r);c.height=Math.round(img.height*r);c.getContext('2d').drawImage(img,0,0,c.width,c.height);c.toBlob(function(b){show(s,b);if(db)db.transaction('p','readwrite').objectStore('p').put(b,s.dataset.slot)},'image/jpeg',.86)};img.src=URL.createObjectURL(f)}});
})();</script></body></html>`;
  }

  const heroOf = (id) => {
    try {
      const d = JSON.parse(fs.readFileSync(file(id), 'utf8'));
      return d.enrich?.hero?.img || pick(id);
    } catch {
      return pick(id);
    }
  };
  const tile = (L) => (s) => `<a class="tile" href="/t/${s.id}"><div class="ph" style="background-image:url('${esc(s.img || heroOf(s.id))}')"><span>${esc(s.countries.map(flag).join(' '))} ${esc(s.days + W[L].days)}</span></div><div class="tx"><b>${jp((s.emoji ? s.emoji + ' ' : '') + nameOf(s, L))}</b><span class="meta">${esc(citiesOf(s, L).slice(0, 4).join(' · '))}</span></div></a>`;

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
    // 旅のDNA（アプリから共有されたリンク）。コードは15軸の値と季節だけで、個人を特定する情報は含まない
    let dm = p.match(/^\/dna\/([0-9a-z]{16})$/i);
    if (dm && req.method === 'GET') {
      const L = langOf(req);
      const code = dm[1].toLowerCase();
      const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
      if (!/^[0-9a-z]{15}[0-3]$/.test(code)) return page(res, 404, { title: 'Not found', L, body: '<div class="wrap"><div class="card">Not found</div></div>' });
      const v = [...code.slice(0, 15)].map((ch) => Math.round((B36.indexOf(ch) / 35) * 100));
      const type = dnaType(v, L === 'ja');
      const HU = [18, 42, 200, 8, 160, 280, 225, 250, 120, 30, 330, 190, 48, 265, 350];
      const seg = 960 / 15;
      const bars = v.flatMap((x, i) => {
        const n = 1 + Math.floor(x / 22);
        const th = Math.max(2, (seg * (0.25 + (x / 100) * 0.55)) / n);
        const gap = (seg - th * n) / (n + 1);
        return Array.from({ length: n }, (_, j) => `<rect x="${(i * seg + gap + j * (th + gap)).toFixed(1)}" y="0" width="${th.toFixed(1)}" height="200" rx="3" fill="hsl(${HU[i]},78%,${44 + Math.round((1 - x / 100) * 22)}%)"/>`);
      }).join('');
      const rows = v.map((x, i) => `<div style="display:grid;grid-template-columns:96px 1fr 34px;gap:10px;align-items:center;margin:6px 0"><b style="font-size:14px">${esc(L === 'ja' ? DNA_AXES[i][0] : DNA_AXES[i][1])}</b><div style="height:9px;border-radius:5px;background:#E8E5DF"><div style="width:${Math.max(3, x)}%;height:9px;border-radius:5px;background:hsl(${HU[i]},70%,52%)"></div></div><span class="meta" style="text-align:right">${x}</span></div>`).join('');
      const deep = `tripfold://dna?c=${code}`;
      const body = `<section style="background:#15171C;color:#fff;padding:48px 0 36px"><div class="wrap"><div class="k">TRAVEL DNA</div><h1 style="color:#fff">${jp(type)}</h1><p style="opacity:.8;margin:6px 0 20px">${L === 'ja' ? jp('友達の旅のタイプです。あなたもTripfoldで自分の旅のDNAを調べて、相性を見てみませんか。') : 'Your friend’s travel type. Find yours in Tripfold and see how you match.'}</p><svg viewBox="0 0 960 200" style="width:100%;height:auto;display:block">${bars}</svg><p class="meta" style="letter-spacing:.2em;margin-top:10px">${code.toUpperCase()}</p><div class="btns" style="margin-top:18px"><a class="btn" href="${deep}">${L === 'ja' ? 'アプリで相性を見る' : 'Compare in the app'}</a><a class="btn w" href="${APP_STORE}">${esc(W[L].getApp)}</a></div></div></section>
<div class="wrap" style="padding-top:24px">${rows}<div class="card" style="margin-top:20px"><b>${L === 'ja' ? '旅のDNAとは' : 'What is Travel DNA?'}</b><p style="margin:6px 0 0">${L === 'ja' ? jp('Tripfoldに入れた旅（予定の時間・種類・移動・日数・人数など）から、旅の仕方を15の軸で表したものです。分析は端末の中で行われ、このページには数値だけが含まれます。') : 'Fifteen measures of how you travel, worked out on your phone from the trips in Tripfold. This page only contains the numbers.'}</p></div></div>`;
      return page(res, 200, { title: `${type} | Travel DNA | Tripfold`, desc: L === 'ja' ? `旅のタイプは「${type}」。あなたも旅のDNAを調べて、相性を見てみませんか。` : `Travel type: ${type}. Find yours and compare.`, canonical: `/dna/${code}`, L, body, index: false, image: '/assets/paris.jpg' });
    }
    // 公式しおりの点検（重複・遠すぎる移動・観光地らしくない名前・写真なし など）。数と例だけを返す
    if (p === '/v1/gen/audit' && req.method === 'GET') {
      const km = (a, b) => {
        const R = 6371, t = Math.PI / 180;
        const x = Math.sin(((b.lat - a.lat) * t) / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(((b.lng - a.lng) * t) / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(x));
      };
      const out = { plans: 0, near: [], longLeg: [], late: [], noJa: 0, noJaEx: [], noPhoto: 0, items: 0, names: {}, thin: [], dupTitle: [] };
      const SUS = /(building|tower|center|centre|office|plaza|hotel|station|headquarter|bank|exchange|mall|ビル|タワー|センター|本社|駅|ホテル|モール)/i;
      for (const s0 of (await loadIndex()).values()) {
        if (!s0.official) continue;
        const d = await readJ(file(s0.id));
        if (!d?.enrich) continue;
        out.plans++;
        const its = d.trip.items;
        const g = d.enrich.items || [];
        const geo = its.map((it, i) => (g[i]?.lat ? { ...g[i], it, i } : null)).filter(Boolean);
        out.items += geo.length;
        for (let a = 0; a < geo.length; a++)
          for (let b = a + 1; b < geo.length; b++)
            if (km(geo[a], geo[b]) < 0.15 && out.near.length < 60) out.near.push(`${d.trip.name}｜${geo[a].it.title} ≈ ${geo[b].it.title}`);
        const seen = new Set();
        its.forEach((it) => {
          if (it.type === 'food') return;
          if (seen.has(it.title) && out.dupTitle.length < 40) out.dupTitle.push(`${d.trip.name}｜${it.title}`);
          seen.add(it.title);
          if (SUS.test(it.title) || SUS.test(it.en || '')) out.names[it.title] = (out.names[it.title] || 0) + 1;
          if (it.time && it.time > '21:30' && out.late.length < 30) out.late.push(`${d.trip.name}｜${it.time} ${it.title}`);
          if (d.trip.citiesJa && it.en && it.title === it.en && /^[\x00-\x7f\u00c0-\u024f\s'’.,()-]+$/.test(it.title)) {
            out.noJa++;
            if (out.noJaEx.length < 40) out.noJaEx.push(it.title);
          }
        });
        geo.forEach((x) => !x.img && out.noPhoto++);
        Object.entries(d.enrich.legs || {}).forEach(([i, l]) => {
          const lim = d.trip.car ? 120 : l.mode === 'foot' ? 2.6 : 12;
          if (l.km > lim && out.longLeg.length < 40) out.longLeg.push(`${d.trip.name}｜${its[i]?.title} → ${l.km}km (${l.mode})`);
        });
        if (geo.length < its.filter((x) => x.type !== 'food').length * 0.6 && out.thin.length < 30) out.thin.push(d.trip.name);
      }
      out.names = Object.entries(out.names).sort((a, b) => b[1] - a[1]).slice(0, 80);
      return send(res, 200, out);
    }
    if (p === '/v1/gen/status' && req.method === 'GET') return send(res, 200, { ...gen.status, total: (await loadIndex()).size });
    // SNSで紹介するための一覧（CSV）
    if (p === '/v1/pub/export.csv' && req.method === 'GET') {
      const L = url.searchParams.get('lang') === 'en' ? 'en' : 'ja';
      const rows = [...(await loadIndex()).values()].filter((x) => x.official).map((x) => [x.id, `${ORIGIN}/t/${x.id}`, nameOf(x, L), citiesOf(x, L).join(' / '), x.days, x.theme || 'classic', snsText(x, L)]);
      const csv = '\ufeff' + [['id', 'url', 'name', 'city', 'days', 'theme', 'sns'], ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tripfold-plans-${L}.csv"` });
      return res.end(csv);
    }
    // サイトマップ（トップ・一覧・ガイド・公開しおり）
    if (p === '/sitemap.xml' && req.method === 'GET') {
      const gdir = path.join(__dirname, 'public', 'guides');
      const guides = (await fsp.readdir(gdir).catch(() => [])).filter((f) => f.endsWith('.html')).map((f) => (f === 'index.html' ? '/guides' : '/guides/' + f.slice(0, -5)));
      const all = [...(await loadIndex()).values()];
      const urls = ['/', '/t', ...guides, ...all.map((x) => '/t/' + x.id)];
      const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.map((u) => `<url><loc>${ORIGIN}${u}</loc></url>`).join('\n') + '\n</urlset>\n';
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return res.end(xml);
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
      // 手書きの公式しおり・利用者のしおりを先に、自動生成は後に
      all.sort((a, b) => (a.theme ? 1 : 0) - (b.theme ? 1 : 0) || b.updatedAt - a.updatedAt);
      if (q) all = all.filter((s) => [s.name, s.nameEn, ...s.cities, ...(s.citiesJa || [])].filter(Boolean).join(' ').toLowerCase().includes(q));
      const fd = Number(url.searchParams.get('days')) || 0;
      const ft = String(url.searchParams.get('theme') || '');
      if (fd) all = all.filter((s) => s.days === fd);
      if (ft) all = all.filter((s) => (s.theme || 'classic') === ft);
      const PER = 60;
      const pages = Math.max(1, Math.ceil(all.length / PER));
      const pg = Math.min(pages, Math.max(1, Number(url.searchParams.get('page')) || 1));
      const link = (o) => {
        const u = new URLSearchParams();
        const v = { q, days: fd || '', theme: ft, page: '', ...o };
        Object.entries(v).forEach(([k, x]) => x && u.set(k, x));
        const str = u.toString();
        return '/t' + (str ? '?' + str : '');
      };
      const chip = (label, href, on) => `<a class="fchip${on ? ' on' : ''}" href="${esc(href)}">${esc(label)}</a>`;
      const filters = `<div class="filters">${chip(L === 'ja' ? 'すべての日数' : 'Any length', link({ days: '' }), !fd)}${[2, 3, 4, 5].map((n) => chip(L === 'ja' ? `${n - 1}泊${n}日` : `${n} days`, link({ days: n }), fd === n)).join('')}</div>
<div class="filters">${chip(L === 'ja' ? 'すべてのテーマ' : 'All themes', link({ theme: '' }), !ft)}${Object.entries(THEME_NAME[L]).map(([k, v]) => chip(v, link({ theme: k }), ft === k)).join('')}</div>`;
      const pager = pages > 1 ? `<div class="filters" style="justify-content:center;margin-top:24px">${pg > 1 ? chip(L === 'ja' ? '← 前へ' : '← Prev', link({ page: pg - 1 }), false) : ''}<span class="meta" style="padding:8px 12px">${pg} / ${pages}</span>${pg < pages ? chip(L === 'ja' ? '次へ →' : 'Next →', link({ page: pg + 1 }), false) : ''}</div>` : '';
      const body = `<section class="hero" style="min-height:360px;background-image:url('/assets/paris.jpg')"><div class="wrap"><div class="k">TRIP PLANS</div><h1>${jp(w.list)}</h1><p style="max-width:640px;margin:0;font-size:16px;opacity:.95">${jp(w.listSub)}</p></div></section>
<div class="wrap"><form action="/t" class="qform" style="margin:-26px 0 18px;position:relative;z-index:2"><input class="q" name="q" value="${esc(q)}" placeholder="${esc(w.search)}">${fd ? `<input type="hidden" name="days" value="${fd}">` : ''}${ft ? `<input type="hidden" name="theme" value="${esc(ft)}">` : ''}<button class="qbtn">${L === 'ja' ? '検索' : 'Search'}</button></form>
${filters}<p class="meta">${L === 'ja' ? `${q ? `「${esc(q)}」の` : ''}しおり：${all.length}件` : `${all.length} plans${q ? ` for “${esc(q)}”` : ''}`}</p>${all.length ? `<div class="grid">${all.slice((pg - 1) * PER, pg * PER).map(tile(L)).join('')}</div>${pager}` : `<div class="card">${q ? (L === 'ja' ? `「${esc(q)}」のしおりはまだありません。<a href="/t">すべてのしおり</a>や<a href="/guides">旅行ガイド</a>もご覧ください。` : `No plans for “${esc(q)}” yet. See <a href="/t">all plans</a> or <a href="/guides">guides</a>.`) : jp(w.empty)}</div>`}
<div class="btns" style="margin-top:30px"><a class="btn d" href="${APP_STORE}">${esc(w.getApp)}</a></div></div>`;
      return page(res, 200, { title: `${w.list} | Tripfold`, desc: w.listSub, canonical: '/t', L, body, index: !q && !fd && !ft && pg === 1, image: '/assets/paris.jpg' });
    }
    // 旅の雑誌（印刷用）
    m = p.match(/^\/press\/([a-z0-9]{10})$/);
    if (m && req.method === 'GET') {
      const L = langOf(req);
      const d = await readJ(file(m[1]));
      if (!d || d.hidden) return page(res, 404, { title: 'Tripfold', desc: '', L, body: `<div class="wrap" style="padding:60px 20px"><h1>${L === 'ja' ? 'このしおりは見つかりません' : 'Plan not found'}</h1><a class="btn" href="/t">${esc(W[L].list)}</a></div>`, index: false });
      res.setHeader('Set-Cookie', `lang=${L}; Path=/; Max-Age=31536000; SameSite=Lax`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=60', Vary: 'Cookie, Accept-Language', 'X-Robots-Tag': 'noindex' });
      return res.end(pressPage(d, L));
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
      const desc = `${citiesOf(t, L).join('・')} ${t.days}${W[L].days}: ${t.items.slice(0, 6).map((i) => titleOf(i, L)).join(' / ')}`.slice(0, 160);
      return page(res, 200, { title: `${nameOf(t, L)} | ${W[L].list}`, desc, canonical: `/t/${d.id}`, L, body: tripBody(d, L, others), image: d.enrich?.hero?.img || pick(d.id) });
    }
    return false;
  };
};
