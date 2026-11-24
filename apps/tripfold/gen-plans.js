// 公式しおりの自動生成：都市・地域ごとに Wikidata から実在の名所（位置・日本語名つき）を集め、
// 近い場所同士を同じ日にまとめて、無駄の少ない順番・時間割のしおりを作る。
// 期間（1泊2日〜4泊5日）・テーマ（定番・美術館・歴史・自然・穴場・古城ドライブ・絶景ドライブ）の組み合わせで大量に作る。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const UA = { 'User-Agent': 'TripfoldBot/1.0 (https://tripfold.net; plan generator)', Accept: 'application/sparql-results+json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kmBetween = (a, b) => {
  const R = 6371, t = Math.PI / 180;
  const dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const hash = (s) => crypto.createHash('sha256').update(s).digest();

// Wikidata の分類 → このしおりで使う種類
const ROOTS = {
  Q33506: 'museum', Q207694: 'museum', Q23413: 'castle', Q16560: 'castle', Q57821: 'castle', Q24398318: 'religious', Q1370598: 'religious',
  Q22698: 'park', Q1107656: 'park', Q23442: 'park', Q174782: 'square', Q15243209: 'area', Q839954: 'ruins', Q4989906: 'monument', Q860861: 'monument',
  Q12280: 'bridge', Q12518: 'tower', Q11303: 'tower', Q37654: 'market', Q43501: 'zoo', Q2281788: 'zoo',
  Q23397: 'nature', Q8502: 'nature', Q40080: 'nature', Q34038: 'nature', Q46169: 'nature', Q35509: 'nature', Q1006733: 'nature', Q6017969: 'nature',
  Q24354: 'theatre', Q41176: 'building',
  // 観光の予定に入れないもの
  Q3918: 'X', Q55488: 'X', Q1248784: 'X', Q27686: 'X', Q16917: 'X', Q3914: 'X', Q486972: 'X', Q56061: 'X', Q1190554: 'X', Q5503: 'X', Q483110: 'X',
};
const ORDER = ['museum', 'castle', 'religious', 'ruins', 'park', 'nature', 'market', 'zoo', 'square', 'area', 'bridge', 'tower', 'monument', 'theatre'];
const STRONG = ['castle', 'museum', 'religious', 'park', 'ruins', 'nature'];
const STAY = { museum: 120, castle: 100, religious: 45, ruins: 90, park: 60, nature: 90, market: 60, zoo: 150, square: 30, area: 75, bridge: 25, tower: 60, monument: 30, theatre: 30, building: 60 };
const TICKET = ['museum', 'castle', 'ruins', 'zoo', 'tower'];
const CAP = { bridge: 1, monument: 2, square: 2, tower: 1, theatre: 1, building: 3, area: 2, zoo: 1, market: 1 };

// 種類ごとの一言（ja / en）。場所の名前に合わせて言い回しを少し変える
const TIPS = {
  museum: [['人気の館は時間指定の予約がお勧め。見たい展示を先に決めておくと効率的です。', 'Book a timed ticket for popular museums and pick the rooms you most want to see first.'], ['開館直後か夕方が比較的空いています。大きな荷物は預けることが多いので身軽に。', 'Opening time or late afternoon tends to be quieter. Large bags usually go in the cloakroom.']],
  castle: [['敷地が広いので時間に余裕を。展望の良い場所から街を見渡せます。', 'The grounds are large, so allow time. Look out for the viewpoints over the city.'], ['人気の時間帯は入場に並ぶことも。チケットは事前に買っておくと安心です。', 'Queues can build at busy times, so buy tickets in advance.']],
  religious: [['礼拝中は見学できないことも。肩と膝を隠す服装で、静かに見学を。', 'Visits may pause during services. Cover shoulders and knees and keep your voice down.'], ['内部の装飾も見どころ。撮影の可否は入口で確認を。', 'The interior is a highlight. Check at the entrance whether photos are allowed.']],
  ruins: [['日差しを遮る場所が少ないので、帽子と水を。歩きやすい靴で。', 'There is little shade, so bring a hat and water, and wear good shoes.']],
  park: [['散歩やひと休みに。天気の良い日は飲み物を持って行くのがお勧め。', 'Good for a walk and a break. Bring a drink on a sunny day.'], ['季節ごとに景色が変わります。ベンチでのんびりするのも旅らしい時間です。', 'The scenery changes with the seasons. Slow down on a bench for a while.']],
  nature: [['天気で見え方が大きく変わります。前日に天気予報を確認して。', 'Weather changes everything here, so check the forecast the day before.'], ['歩く場所は足元が悪いことも。滑りにくい靴と上着を。', 'Paths can be uneven. Wear shoes with grip and bring a layer.']],
  market: [['お昼前後が一番にぎやか。小銭やカードを用意して食べ歩きを。', 'Busiest around lunchtime. Have small change or a card ready for snacks.']],
  zoo: [['じっくり見ると半日かかります。動物が活発な午前中がお勧め。', 'A proper visit takes half a day. Animals are most active in the morning.']],
  square: [['街の中心で、周りの建物も見どころ。スリには気を付けて。', 'A central square with fine buildings around it. Watch out for pickpockets.']],
  area: [['路地を気ままに歩くのが楽しい地区。カフェでひと休みも。', 'An area best explored on foot, with cafes for a break.']],
  bridge: [['橋の上からの眺めが見どころ。夕方の景色も綺麗です。', 'Come for the view from the bridge, especially at dusk.']],
  tower: [['展望は夕暮れの時間帯が人気。混む時間は予約を。', 'Sunset is the most popular time for the view. Book ahead for busy slots.']],
  monument: [['通り道に立ち寄れる名所。写真を撮って次へ。', 'A quick stop on the way. Take a photo and move on.']],
  theatre: [['公演がある日は夜の予定に。建物の見学ツアーがある所も。', 'Catch a performance in the evening, or look for a building tour.']],
  building: [['外観も見どころ。内部見学は時間や予約を確認して。', 'The exterior is a sight in itself. Check times and booking for interior visits.']],
};

const THEMES = {
  classic: { ja: (c, n) => (n === 2 ? `${c} 1泊2日 名所を一気に` : `${c} ${n - 1}泊${n}日 定番を効率よく`), en: (c, n) => (n === 2 ? `${c} in 2 days: the highlights` : `${c} in ${n} days: the classics, efficiently`), noteJa: '有名な場所を、近い所同士で同じ日にまとめ、移動の無駄が少ない順番に並べました。到着日は午後から、最終日は午前中で終わる時間割です。', noteEn: 'The best-known sights, grouped by area so each day has little back-and-forth. Day one starts in the afternoon and the last day ends by lunchtime.' },
  art: { ja: (c, n) => `${c} 美術館・博物館巡り ${n - 1}泊${n}日`, en: (c, n) => `${c} for art and museum lovers (${n} days)`, noteJa: '美術館・博物館を中心に、近い所を同じ日にまとめた旅程です。大きな館は午前中に入れています。', noteEn: 'Built around museums and galleries, grouped by area. The big ones are placed in the mornings.' },
  history: { ja: (c, n) => `${c} 歴史と建築を巡る ${n - 1}泊${n}日`, en: (c, n) => `${c}: history and architecture in ${n} days`, noteJa: '城・宮殿・教会や寺院など、歴史ある建物を中心に回る旅程です。', noteEn: 'Castles, palaces, churches and temples: a route through the city’s history.' },
  nature: { ja: (c, n) => `${c} 公園と景色でのんびり ${n - 1}泊${n}日`, en: (c, n) => `${c}: parks and views at an easy pace (${n} days)`, noteJa: '公園や景色の良い場所を多めに入れた、詰め込みすぎない旅程です。', noteEn: 'More parks and viewpoints, fewer queues: a relaxed pace.' },
  hidden: { ja: (c, n) => `${c} 2回目の人へ 穴場巡り ${n - 1}泊${n}日`, en: (c, n) => `${c}: beyond the classics (${n} days)`, noteJa: '定番の次に行きたい場所を集めました。2回目の旅や、人混みを避けたい人に。', noteEn: 'The places to see after the classics: for a second visit, or for fewer crowds.' },
  castle: { ja: (c, n) => `${c} 古城巡りドライブ ${n - 1}泊${n}日`, en: (c, n) => `${c} castle road trip (${n} days)`, noteJa: 'レンタカーで城や宮殿を巡る旅程です。運転時間が長くなりすぎないよう、近い所を同じ日にまとめています。', noteEn: 'A road trip between castles and palaces, grouped so the driving each day stays reasonable.' },
  scenic: { ja: (c, n) => `${c} 湖と絶景ドライブ ${n - 1}泊${n}日`, en: (c, n) => `${c} scenic road trip (${n} days)`, noteJa: 'レンタカーで湖や山、景色の良い場所を巡る旅程です。天気で見え方が変わるので、予定は柔軟に。', noteEn: 'A road trip to lakes, mountains and viewpoints. Weather matters, so stay flexible.' },
};

function sparql(lat, lng, km, minLinks) {
  return `SELECT ?item ?en ?ja ?sl ?lat ?lon ?enwiki ?jawiki (GROUP_CONCAT(DISTINCT STRAFTER(STR(?c),'entity/');separator=',') AS ?cls) WHERE {
SERVICE wikibase:around { ?item wdt:P625 ?loc . bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "${km}" . }
?item wikibase:sitelinks ?sl . FILTER(?sl >= ${minLinks})
?item wdt:P31 ?c .
FILTER NOT EXISTS { ?item wdt:P576 [] } FILTER NOT EXISTS { ?item wdt:P3999 [] }
?item rdfs:label ?en FILTER(lang(?en)='en')
OPTIONAL { ?item rdfs:label ?ja FILTER(lang(?ja)='ja') }
OPTIONAL { ?ew schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki }
OPTIONAL { ?jw schema:about ?item; schema:isPartOf <https://ja.wikipedia.org/>; schema:name ?jawiki }
BIND(geof:latitude(?loc) AS ?lat) BIND(geof:longitude(?loc) AS ?lon)
} GROUP BY ?item ?en ?ja ?sl ?lat ?lon ?enwiki ?jawiki ORDER BY DESC(?sl) LIMIT 300`;
}

async function wdq(q) {
  for (let tryN = 0; tryN < 3; tryN++) {
    try {
      const r = await fetch('https://query.wikidata.org/sparql?format=json', { method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'query=' + encodeURIComponent(q), signal: AbortSignal.timeout(60000) });
      if (r.ok) return (await r.json()).results.bindings;
      if (r.status === 429) await sleep(30000);
    } catch {}
    await sleep(5000);
  }
  return null;
}

module.exports = function makeGen({ DATA, readJ, writeJ, onPlan, log = console.log }) {
  const DIR = path.join(DATA, 'gen');
  const SEED = path.join(__dirname, 'seed');
  fs.mkdirSync(path.join(DIR, 'pois'), { recursive: true });
  const status = { started: 0, places: 0, done: 0, plans: 0, wiki: 0, err: 0, phase: 'idle' };

  async function classes(ids) {
    const f = path.join(DIR, 'classes.json');
    const map = (await readJ(f)) || {};
    const need = ids.filter((c) => !(c in map));
    for (let i = 0; i < need.length; i += 150) {
      const part = need.slice(i, i + 150);
      const rows = await wdq(`SELECT ?c ?root WHERE { VALUES ?c { ${part.map((c) => 'wd:' + c).join(' ')} } VALUES ?root { ${Object.keys(ROOTS).map((c) => 'wd:' + c).join(' ')} } ?c wdt:P279* ?root . }`);
      if (!rows) continue;
      part.forEach((c) => (map[c] = []));
      for (const b of rows) {
        const c = b.c.value.split('/').pop();
        const k = ROOTS[b.root.value.split('/').pop()];
        if (!map[c].includes(k)) map[c].push(k);
      }
      await writeJ(f, map);
      await sleep(1500);
    }
    return map;
  }

  async function pois(place) {
    const f = path.join(DIR, 'pois', place.slug + '.json');
    const cached = await readJ(f);
    if (cached && Date.now() - cached.at < 60 * 864e5) return cached.list;
    const rows = await wdq(sparql(place.lat, place.lng, place.km, place.region ? 6 : 10));
    if (!rows) return cached?.list || null;
    const map = await classes([...new Set(rows.flatMap((b) => b.cls.value.split(',')))]);
    const seen = new Set();
    const list = [];
    for (const b of rows) {
      const q = b.item.value.split('/').pop();
      if (seen.has(q)) continue;
      seen.add(q);
      const s = new Set(b.cls.value.split(',').flatMap((c) => map[c] || []));
      let cat = ORDER.find((k) => s.has(k));
      if (cat && s.has('X') && !STRONG.includes(cat)) cat = null;
      if (!cat) cat = s.has('X') ? null : s.has('building') ? 'building' : null;
      if (!cat) continue;
      const en = b.en.value;
      if (/^Q\d+$/.test(en) || /\b(district|county|province|metro|line|station|university|airport|stadium|arena)\b/i.test(en)) continue;
      list.push({ q, en, ja: b.ja?.value || null, sl: Number(b.sl.value), lat: Number(b.lat.value), lng: Number(b.lon.value), cat, enwiki: b.enwiki?.value || null, jawiki: b.jawiki?.value || null });
    }
    await writeJ(f, { at: Date.now(), list });
    return list;
  }

  // 一番短くなりそうな順番（近い所から順に → 2-opt で交差をほどく）
  function order(pts, start) {
    if (pts.length < 3) return pts;
    const rest = pts.slice();
    let cur = rest.reduce((best, p) => (kmBetween(p, start) < kmBetween(best, start) ? p : best), rest[0]);
    const out = [cur];
    rest.splice(rest.indexOf(cur), 1);
    while (rest.length) {
      cur = rest.reduce((best, p) => (kmBetween(p, cur) < kmBetween(best, cur) ? p : best), rest[0]);
      out.push(cur);
      rest.splice(rest.indexOf(cur), 1);
    }
    let improved = true;
    for (let guard = 0; improved && guard < 50; guard++) {
      improved = false;
      for (let i = 0; i < out.length - 2; i++)
        for (let j = i + 2; j < out.length - 1; j++) {
          const d0 = kmBetween(out[i], out[i + 1]) + kmBetween(out[j], out[j + 1]);
          const d1 = kmBetween(out[i], out[j]) + kmBetween(out[i + 1], out[j + 1]);
          if (d1 + 1e-9 < d0) {
            out.splice(i + 1, j - i, ...out.slice(i + 1, j + 1).reverse());
            improved = true;
          }
        }
    }
    return out;
  }

  function pickPool(list, wanted, n, avoid) {
    const out = [];
    const used = {};
    const tryAdd = (p) => {
      if (out.length >= n || out.includes(p) || avoid?.has(p.q)) return;
      if ((used[p.cat] || 0) >= (CAP[p.cat] ?? 99)) return;
      if (out.some((o) => kmBetween(o, p) < 0.08)) return; // ほぼ同じ場所（城と同じ敷地の博物館など）は1つに
      used[p.cat] = (used[p.cat] || 0) + 1;
      out.push(p);
    };
    list.filter((p) => wanted.includes(p.cat)).forEach(tryAdd);
    return out;
  }

  function build(place, theme, days) {
    const car = !!place.region;
    const perDay = car ? [2, 4, 4, 4, 2] : [3, 5, 5, 5, 2];
    const caps = Array.from({ length: days }, (_, i) => (i === 0 ? perDay[0] : i === days - 1 ? perDay[4] : perDay[1]));
    const N = caps.reduce((a, b) => a + b, 0);
    const all = place.list.filter((p) => kmBetween(p, place) <= place.km);
    const top = all.slice(0, 12).map((p) => p.q);
    const want = {
      classic: ORDER,
      art: ['museum'],
      history: ['castle', 'religious', 'ruins', 'monument', 'square'],
      nature: ['park', 'nature', 'zoo', 'tower', 'bridge'],
      hidden: ORDER,
      castle: ['castle', 'ruins', 'religious'],
      scenic: ['nature', 'park', 'tower', 'castle'],
    }[theme];
    let chosen = pickPool(all, want, N, theme === 'hidden' ? new Set(top) : null);
    const core = theme === 'classic' || theme === 'hidden' ? N : Math.ceil(N * 0.6);
    if (chosen.length < Math.min(core, N - 2)) return null; // テーマに合う場所が足りない
    if (chosen.length < N) chosen = chosen.concat(pickPool(all.filter((p) => !chosen.includes(p)), ORDER, N - chosen.length, theme === 'hidden' ? new Set(top) : null));
    if (chosen.length < N - 2) return null;
    const route = order(chosen, place);
    // 順番どおりに日へ分ける（近い所が同じ日になる）
    const daysPts = [];
    let k = 0;
    for (let d = 0; d < days; d++) {
      const take = d === days - 1 ? route.length - k : Math.min(caps[d], route.length - k);
      daysPts.push(route.slice(k, k + take));
      k += take;
    }
    if (daysPts.some((x) => !x.length)) return null;
    const items = [];
    const geo = [];
    const legs = {};
    const usedNight = new Set();
    daysPts.forEach((pts, d) => {
      let t = d === 0 ? (car ? 12 * 60 : 13 * 60 + 30) : 9 * 60 + 30;
      let lunch = d === 0;
      pts.forEach((p, i) => {
        if (i > 0) {
          const km = kmBetween(pts[i - 1], p);
          const mode = car ? 'car' : km <= 2.5 ? 'foot' : 'transit';
          const min = Math.max(5, Math.round(mode === 'foot' ? km * 14 : car ? km * 1.3 + 5 : km * 3 + 10));
          legs[String(items.length - 1)] = { mode, min, km: Math.round(km * 10) / 10, rough: true };
          t += min;
        }
        if (!lunch && t >= 11 * 60 + 45) {
          const nm = p.ja || p.en;
          items.push({ type: 'food', title: `昼食（${nm}の近くで）`, en: `Lunch near ${p.en}`, day: d + 1, time: hm(roundQ(Math.max(t, 12 * 60))) });
          geo.push(null);
          t = roundQ(Math.max(t, 12 * 60)) + 60;
          lunch = true;
        }
        const tip = TIPS[p.cat] || TIPS.building;
        const pickTip = tip[hash(p.q)[0] % tip.length];
        items.push({ type: TICKET.includes(p.cat) ? 'ticket' : 'plan', title: p.ja || p.en, en: p.en, day: d + 1, time: hm(roundQ(t)), tip: { ja: pickTip[0], en: pickTip[1] }, q: p.q });
        geo.push({ lat: p.lat, lng: p.lng, wiki: { en: p.enwiki, ja: p.jawiki } });
        t = roundQ(t) + (STAY[p.cat] || 60);
      });
      // 夕方以降：夕食と、夜景の名所（ライトアップされた橋や塔など）。最終日は午前で終わるので入れない
      if (d < days - 1 && !car && pts.length) {
        const last = pts[pts.length - 1];
        const night = all
          .filter((x) => ['tower', 'bridge', 'square', 'area'].includes(x.cat) && !chosen.includes(x) && !usedNight.has(x.q) && kmBetween(x, last) < 3)
          .sort((a, b) => kmBetween(a, last) - kmBetween(b, last))[0];
        const dt = roundQ(Math.max(t + 15, 18 * 60 + 30));
        items.push({ type: 'food', title: `夕食（${night ? night.ja || night.en : last.ja || last.en}の近くで）`, en: `Dinner near ${night ? night.en : last.en}`, day: d + 1, time: hm(dt) });
        geo.push(null);
        if (night) {
          usedNight.add(night.q);
          legs[String(items.length - 2)] = (() => {
            const km = kmBetween(last, night);
            const mode = km <= 2.5 ? 'foot' : 'transit';
            return { mode, min: Math.max(5, Math.round(mode === 'foot' ? km * 14 : km * 3 + 10)), km: Math.round(km * 10) / 10, rough: true };
          })();
          items.push({ type: 'plan', title: night.ja || night.en, en: night.en, day: d + 1, time: hm(dt + 90), tip: { ja: '夜はライトアップされた景色がお勧め。帰りの交通手段も確認しておくと安心です。', en: 'Best after dark when it is lit up. Check how you will get back before you go.' }, q: night.q });
          geo.push({ lat: night.lat, lng: night.lng, wiki: { en: night.enwiki, ja: night.jawiki } });
        }
      }
    });
    const th = THEMES[theme];
    const nameJ = place.ja, nameE = place.en;
    return {
      slug: `g-${place.slug}-${theme}-${days}`,
      trip: { name: th.ja(nameJ, days), nameEn: th.en(nameE, days), emoji: place.emoji, days, theme, car, cities: [place.en], citiesJa: [place.ja], countries: [place.cc], note: th.noteJa, noteEn: th.noteEn, items },
      geo,
      legs,
    };
  }
  const hm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const roundQ = (m) => Math.round(m / 15) * 15;

  // Wikipedia の説明と写真（20件ずつまとめて取る。結果は保存して使い回す）
  async function wikiBatch(lang, titles) {
    const f = path.join(DIR, `wiki-${lang}.json`);
    const cache = (await readJ(f)) || {};
    const need = [...new Set(titles.filter((t) => t && !(t in cache)))];
    for (let i = 0; i < need.length; i += 20) {
      const part = need.slice(i, i + 20);
      try {
        const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
        Object.entries({ action: 'query', format: 'json', redirects: '1', prop: 'extracts|pageimages|info', exintro: '1', explaintext: '1', exsentences: '3', exlimit: '20', piprop: 'thumbnail', pithumbsize: '800', inprop: 'url', titles: part.join('|') }).forEach(([k, v]) => u.searchParams.set(k, v));
        const j = await (await fetch(u, { headers: { 'User-Agent': UA['User-Agent'] }, signal: AbortSignal.timeout(20000) })).json();
        const back = {};
        (j.query?.normalized || []).forEach((n) => (back[n.to] = n.from));
        (j.query?.redirects || []).forEach((n) => (back[n.to] = back[n.from] || n.from));
        part.forEach((t) => (cache[t] = null));
        for (const pg of Object.values(j.query?.pages || {})) {
          const key = back[pg.title] || pg.title;
          cache[key] = { img: pg.thumbnail?.source, desc: String(pg.extract || '').replace(/\s*\([^)]*\)/g, '').replace(/（[^）]*）/g, '').slice(0, 260), url: pg.fullurl };
        }
        status.wiki += part.length;
      } catch {
        status.err++;
      }
      await sleep(400);
    }
    await writeJ(f, cache);
    return cache;
  }

  async function run() {
    status.started = Date.now();
    status.phase = 'places';
    let cities = [], regions = [];
    try {
      cities = JSON.parse(await fsp.readFile(path.join(SEED, 'gen-cities.json'), 'utf8'));
      regions = JSON.parse(await fsp.readFile(path.join(SEED, 'gen-regions.json'), 'utf8'));
    } catch (e) {
      log('gen: no config', e.message);
      return;
    }
    const hand = new Set();
    for (const f of (await fsp.readdir(SEED)).filter((x) => /^\d.*\.json$/.test(x))) {
      try {
        JSON.parse(await fsp.readFile(path.join(SEED, f), 'utf8')).forEach((p) => hand.add(p.slug));
      } catch {}
    }
    const places = [
      ...cities.map(([slug, en, ja, cc, lat, lng, km, emoji]) => ({ slug, en, ja, cc, lat, lng, km, emoji })),
      ...regions.map(([slug, en, ja, cc, lat, lng, km, emoji, theme]) => ({ slug, en, ja, cc, lat, lng, km, emoji, theme, region: true })),
    ];
    status.places = places.length;
    let n = 0;
    for (const place of places) {
      try {
        const list = await pois(place);
        if (!list || list.length < 6) {
          status.done++;
          continue;
        }
        place.list = list;
        const variants = place.region
          ? [[place.theme, 3], [place.theme, 4], [place.theme, 5]]
          : [['classic', 2], ['classic', 3], ['classic', 4], ['classic', 5], ['art', 3], ['history', 3], ['nature', 3], ['hidden', 3], ['art', 2], ['history', 4]];
        const plans = [];
        for (const [theme, days] of variants) {
          if (theme === 'classic' && days === 3 && hand.has(`${place.slug}-3d`)) continue;
          const p = build(place, theme, days);
          if (p) plans.push(p);
        }
        // 写真と説明
        const en = await wikiBatch('en', plans.flatMap((p) => p.geo.filter(Boolean).map((g) => g.wiki.en)).concat([place.en]));
        const ja = await wikiBatch('ja', plans.flatMap((p) => p.geo.filter(Boolean).map((g) => g.wiki.ja)).concat([place.ja]));
        const hero = en[place.en] || null;
        for (const p of plans) {
          const items = p.geo.map((g) => {
            if (!g) return null;
            const we = g.wiki.en ? en[g.wiki.en] : null;
            const wj = g.wiki.ja ? ja[g.wiki.ja] : null;
            return { lat: g.lat, lng: g.lng, ...(we ? { img: we.img, desc: we.desc, wt: g.wiki.en, wu: we.url } : {}), ...(wj ? { img: we?.img || wj.img, dja: wj.desc, wuja: wj.url } : {}) };
          });
          const enrich = { at: Date.now(), gen: true, items, legs: p.legs, hero: hero?.img ? { img: hero.img, desc: hero.desc, title: place.en, url: hero.url, ...(ja[place.ja] ? { dja: ja[place.ja].desc, uja: ja[place.ja].url } : {}) } : null };
          await onPlan(p.slug, p.trip, enrich, n++);
          status.plans++;
        }
      } catch (e) {
        status.err++;
        log('gen', place.slug, e.message);
      }
      status.done++;
      await sleep(1500);
    }
    status.phase = 'done';
    log('gen: plans', status.plans);
  }
  return { run, status };
};
