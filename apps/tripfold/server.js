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
const COLLECTIONS = ['bookings', 'expenses', 'checklist', 'members', 'wishes', 'inbox'];
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


/* ---------- 場所の名前で探す（OpenStreetMap の Nominatim。1秒に1回まで・結果は保存して使い回す） ---------- */
let nomiQueue = Promise.resolve();
function nominatim(q, near, lang) {
  const job = nomiQueue.then(async () => {
    const u = new URL('https://nominatim.openstreetmap.org/search');
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('limit', '1');
    u.searchParams.set('q', q);
    if (near) {
      const d = 0.7;
      u.searchParams.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
      u.searchParams.set('bounded', '1');
    }
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Tripfold/1.0 (travel planner app; https://tripfold.160-251-171-249.sslip.io)', 'Accept-Language': lang || 'en' }, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const g = Array.isArray(j) && j[0];
      return g ? { lat: Math.round(Number(g.lat) * 1e6) / 1e6, lng: Math.round(Number(g.lon) * 1e6) / 1e6, name: String(g.display_name || '').slice(0, 200) } : null;
    } catch {
      return undefined; // 失敗（保存しない）
    } finally {
      await new Promise((r) => setTimeout(r, 1100));
    }
  });
  nomiQueue = job.catch(() => null);
  return job;
}

/* ---------- 名前の補助：Wikipedia の座標（日本語・韓国語・中国語の地名に強い） ---------- */
// OpenStreetMap は「サクレ・クール寺院」「ヴェルサイユ宮殿」のようなカタカナ名で見つからないことが多い。
// その場合、その言語の Wikipedia を検索して、記事の座標を使う（near があれば 60km 以内のものだけ）
let wikiQueue = Promise.resolve();
function wikiGeo(q, near) {
  const lang = /[぀-ヿ]/.test(q) ? ['ja', 'en'] : /[가-힯]/.test(q) ? ['ko', 'en'] : /[一-鿿]/.test(q) ? ['ja', 'zh', 'en'] : ['en'];
  const job = wikiQueue.then(async () => {
    for (const l of lang) {
      try {
        const u = new URL(`https://${l}.wikipedia.org/w/api.php`);
        Object.entries({ action: 'query', format: 'json', generator: 'search', gsrsearch: q, gsrlimit: '6', prop: 'coordinates|langlinks', coprimary: 'primary', lllang: 'en', lllimit: 'max' }).forEach(([k, v]) => u.searchParams.set(k, v));
        const r = await fetch(u, { headers: { 'User-Agent': 'Tripfold/1.0 (travel planner app; https://tripfold.160-251-171-249.sslip.io)' }, signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        const pages = Object.values(j?.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        for (const [i, pg] of pages.entries()) {
          let c = pg.coordinates?.[0];
          // 日本語版に座標がない記事（例：トレヴィの泉）は、英語版の記事の座標を使う
          const en = pg.langlinks?.[0]?.['*'];
          if (!c && en && l !== 'en' && i < 3) {
            try {
              const u2 = new URL('https://en.wikipedia.org/w/api.php');
              Object.entries({ action: 'query', format: 'json', titles: en, prop: 'coordinates', coprimary: 'primary', redirects: '1' }).forEach(([k, v]) => u2.searchParams.set(k, v));
              const j2 = await (await fetch(u2, { headers: { 'User-Agent': 'Tripfold/1.0 (travel planner app)' }, signal: AbortSignal.timeout(6000) })).json();
              c = Object.values(j2?.query?.pages ?? {})[0]?.coordinates?.[0];
            } catch {}
          }
          if (!c) continue;
          const g = { lat: Math.round(c.lat * 1e6) / 1e6, lng: Math.round(c.lon * 1e6) / 1e6, name: String(pg.title || '').slice(0, 200), src: 'wiki' };
          if (near && Math.hypot(g.lat - near.lat, (g.lng - near.lng) * Math.cos((near.lat * Math.PI) / 180)) * 111 > 60) continue;
          return g;
        }
      } catch {}
    }
    return null;
  });
  wikiQueue = job.catch(() => null);
  return job;
}
// 日本の住所（〒・都道府県・丁目・番地）は国土地理院の住所検索がいちばん正確
const JA_ADDR = /(〒\s?\d{3}-?\d{4}|[都道府県].{0,12}[市区町村郡]|丁目|番地|\d+-\d+(-\d+)?$)/;
async function gsiGeo(q) {
  try {
    const qq = q.replace(/〒\s?\d{3}-?\d{4}\s*/, '').replace(/\s+/g, '').slice(0, 80);
    const r = await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(qq), { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const f = Array.isArray(j) ? j[0] : null;
    if (!f?.geometry?.coordinates) return null;
    const [lng, lat] = f.geometry.coordinates;
    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, name: String(f.properties?.title || qq).slice(0, 200), src: 'gsi' };
  } catch {
    return null;
  }
}
// 「ランチ」「ホテル」「カフェ」だけの予定は場所がわからない（遠くの同じ名前の店に立てないように）
const GENERIC = /^(ホテル|宿|旅館|カフェ|喫茶店?|ランチ|ディナー|朝食|昼食|夕食|朝ごはん|昼ごはん|晩ごはん|夜ごはん|食事|レストラン|居酒屋|バー|ショッピング|買い物|お土産|おみやげ|散策|散歩|観光|自由時間|自由行動|休憩|移動|集合|解散|出発|到着|帰国|チェックイン|チェックアウト|空港|駅|hotel|hostel|cafe|café|coffee|lunch|dinner|breakfast|brunch|restaurant|bar|pub|shopping|souvenirs?|free time|rest|break|check[- ]?in|check[- ]?out|airport|station|호텔|카페|점심|저녁|아침|쇼핑|酒店|咖啡|午餐|晚餐|早餐|购物|自由活动)$/i;

// 「モンマルトルを散策」「ルーブルでランチ」→ 場所の名前だけにする
const cleanPlace = (q) =>
  q
    .replace(/(を|で|に|へ|の)?(散策|観光|見学|訪問|散歩|ぶらぶら|楽しむ|行く|立ち寄る|ランチ|ディナー|朝食|夕食|ショッピング|買い物)(する)?$/, '')
    .replace(/^(.+?)(に戻る|へ戻る|に帰る)$/, '$1')
    .trim();

/* ---------- 道のり（OpenStreetMap の経路：徒歩・車） ---------- */
const routes = new Map(); // 'foot|lat,lng|lat,lng' → { coords, km, min } / null
let routeQueue = Promise.resolve();
function osmRoute(mode, a, b) {
  const job = routeQueue.then(async () => {
    const prof = mode === 'foot' ? 'routed-foot' : 'routed-car';
    const u = `https://routing.openstreetmap.de/${prof}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=simplified&geometries=geojson`;
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Tripfold/1.0 (travel planner app; https://tripfold.160-251-171-249.sslip.io)' }, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const rt = j && j.routes && j.routes[0];
      if (!rt) return null;
      const coords = (rt.geometry?.coordinates || []).slice(0, 400).map(([lng, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]);
      return { coords, km: Math.round(rt.distance / 10) / 100, min: Math.round(rt.duration / 60) };
    } catch {
      return undefined;
    } finally {
      await new Promise((r) => setTimeout(r, 600));
    }
  });
  routeQueue = job.catch(() => null);
  return job;
}

/* ---------- 写真 ---------- */
function photoType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(4, 12).toString('latin1').match(/^ftyp(heic|heix|mif1|msf1|avif)/)) return 'heic';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
const MIME = { jpg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp' };



/* ---------- Webページの言葉（ブラウザの言語で切り替え） ---------- */
const W = {
  ja: { trip: '旅行', inviteGone: 'この招待は見つかりません', inviteGoneSub: '共有が終わっているか、コードが違うかもしれません。', joinTitle: '{name} に参加', invited: '「{name}」に招待されています', inviteBody: 'Tripfold で一緒に予定・費用・写真を編集できます。', openJoin: 'アプリで開いて参加', getApp: 'アプリを入れる（App Store）', splitOnly: 'アプリなしで割り勘だけ見る', codeHint: 'アプリで「共有コードで参加」に入れるコード', notFound: '見つかりません', noSettle: '精算は必要ありません。', paid: '払った', share: '分担', splitTitle: '{name} の割り勘', whoPays: 'だれが誰に渡すか（{c}・今日のレート）', total: '合計', details: '内訳', none: 'まだありません', openApp: 'アプリで開く', auto: 'このページは共有している旅行の内容から自動で作られています。共有をやめると見られなくなります。' },
  en: { trip: 'Trip', inviteGone: 'This invite wasn’t found', inviteGoneSub: 'Sharing may have ended, or the code may be wrong.', joinTitle: 'Join {name}', invited: 'You’re invited to “{name}”', inviteBody: 'Plan bookings, costs and photos together in Tripfold.', openJoin: 'Open in the app and join', getApp: 'Get the app (App Store)', splitOnly: 'See the split without the app', codeHint: 'Code for “Join with a share code” in the app', notFound: 'Not found', noSettle: 'Nothing to settle.', paid: 'Paid', share: 'Share', splitTitle: '{name} — settle up', whoPays: 'Who pays whom ({c}, today’s rate)', total: 'Total', details: 'Details', none: 'Nothing yet', openApp: 'Open in the app', auto: 'This page is made automatically from the shared trip. It disappears when sharing stops.' },
  ko: { trip: '여행', inviteGone: '초대를 찾을 수 없어요', inviteGoneSub: '공유가 끝났거나 코드가 다를 수 있어요.', joinTitle: '{name} 참여', invited: '「{name}」에 초대받았어요', inviteBody: 'Tripfold에서 일정·비용·사진을 함께 편집할 수 있어요.', openJoin: '앱에서 열고 참여', getApp: '앱 받기 (App Store)', splitOnly: '앱 없이 정산만 보기', codeHint: '앱의 「공유 코드로 참여」에 넣을 코드', notFound: '찾을 수 없어요', noSettle: '정산할 금액이 없어요.', paid: '낸 돈', share: '부담', splitTitle: '{name} 정산', whoPays: '누가 누구에게 줄까 ({c}·오늘 환율)', total: '합계', details: '내역', none: '아직 없어요', openApp: '앱에서 열기', auto: '이 페이지는 공유 중인 여행에서 자동으로 만들어져요. 공유를 멈추면 볼 수 없어요.' },
  'zh-Hans': { trip: '旅行', inviteGone: '找不到这个邀请', inviteGoneSub: '分享可能已结束，或者分享码不对。', joinTitle: '加入 {name}', invited: '你被邀请加入「{name}」', inviteBody: '在 Tripfold 中一起编辑行程、费用和照片。', openJoin: '在应用中打开并加入', getApp: '下载应用（App Store）', splitOnly: '不用应用，只看分账', codeHint: '在应用「用分享码加入」中输入的分享码', notFound: '找不到', noSettle: '无需结算。', paid: '已付', share: '应摊', splitTitle: '{name} 的分账', whoPays: '谁付给谁（{c}·今日汇率）', total: '合计', details: '明细', none: '暂无', openApp: '在应用中打开', auto: '此页面根据分享的旅行自动生成，停止分享后将无法查看。' },
  'zh-Hant': { trip: '旅行', inviteGone: '找不到這個邀請', inviteGoneSub: '分享可能已結束，或分享碼不正確。', joinTitle: '加入 {name}', invited: '你被邀請加入「{name}」', inviteBody: '在 Tripfold 中一起編輯行程、費用和照片。', openJoin: '在 App 中開啟並加入', getApp: '下載 App（App Store）', splitOnly: '不用 App，只看分帳', codeHint: '在 App「用分享碼加入」中輸入的分享碼', notFound: '找不到', noSettle: '無需結算。', paid: '已付', share: '應攤', splitTitle: '{name} 的分帳', whoPays: '誰付給誰（{c}・今日匯率）', total: '合計', details: '明細', none: '尚無', openApp: '在 App 中開啟', auto: '此頁面根據分享的旅行自動產生，停止分享後將無法查看。' },
  es: { trip: 'Viaje', inviteGone: 'No se encontró esta invitación', inviteGoneSub: 'Puede que se haya dejado de compartir o que el código sea incorrecto.', joinTitle: 'Unirse a {name}', invited: 'Te invitan a «{name}»', inviteBody: 'Planead juntos reservas, gastos y fotos en Tripfold.', openJoin: 'Abrir en la app y unirse', getApp: 'Descargar la app (App Store)', splitOnly: 'Ver las cuentas sin la app', codeHint: 'Código para «Unirse con un código» en la app', notFound: 'No encontrado', noSettle: 'No hay nada que saldar.', paid: 'Pagado', share: 'Le toca', splitTitle: 'Cuentas de {name}', whoPays: 'Quién paga a quién ({c}, cambio de hoy)', total: 'Total', details: 'Detalle', none: 'Nada aún', openApp: 'Abrir en la app', auto: 'Esta página se crea automáticamente a partir del viaje compartido. Desaparece al dejar de compartir.' },
  fr: { trip: 'Voyage', inviteGone: 'Invitation introuvable', inviteGoneSub: 'Le partage est peut-être terminé, ou le code est incorrect.', joinTitle: 'Rejoindre {name}', invited: 'Vous êtes invité à « {name} »', inviteBody: 'Préparez ensemble réservations, dépenses et photos dans Tripfold.', openJoin: 'Ouvrir dans l’app et rejoindre', getApp: 'Télécharger l’app (App Store)', splitOnly: 'Voir les comptes sans l’app', codeHint: 'Code pour « Rejoindre avec un code » dans l’app', notFound: 'Introuvable', noSettle: 'Rien à régler.', paid: 'Payé', share: 'Part', splitTitle: 'Comptes de {name}', whoPays: 'Qui doit à qui ({c}, taux du jour)', total: 'Total', details: 'Détail', none: 'Rien pour l’instant', openApp: 'Ouvrir dans l’app', auto: 'Cette page est créée automatiquement à partir du voyage partagé. Elle disparaît quand le partage s’arrête.' },
  de: { trip: 'Reise', inviteGone: 'Einladung nicht gefunden', inviteGoneSub: 'Das Teilen wurde vielleicht beendet oder der Code stimmt nicht.', joinTitle: '{name} beitreten', invited: 'Du bist zu „{name}“ eingeladen', inviteBody: 'Plant Buchungen, Kosten und Fotos gemeinsam in Tripfold.', openJoin: 'In der App öffnen und beitreten', getApp: 'App laden (App Store)', splitOnly: 'Abrechnung ohne App ansehen', codeHint: 'Code für „Mit Code beitreten“ in der App', notFound: 'Nicht gefunden', noSettle: 'Nichts abzurechnen.', paid: 'Bezahlt', share: 'Anteil', splitTitle: 'Abrechnung: {name}', whoPays: 'Wer zahlt wem ({c}, heutiger Kurs)', total: 'Gesamt', details: 'Details', none: 'Noch nichts', openApp: 'In der App öffnen', auto: 'Diese Seite wird automatisch aus der geteilten Reise erstellt und verschwindet, wenn das Teilen endet.' },
  it: { trip: 'Viaggio', inviteGone: 'Invito non trovato', inviteGoneSub: 'La condivisione potrebbe essere terminata o il codice è sbagliato.', joinTitle: 'Unisciti a {name}', invited: 'Sei invitato a «{name}»', inviteBody: 'Organizzate insieme prenotazioni, spese e foto in Tripfold.', openJoin: 'Apri nell’app e unisciti', getApp: 'Scarica l’app (App Store)', splitOnly: 'Vedi i conti senza l’app', codeHint: 'Codice per «Unisciti con un codice» nell’app', notFound: 'Non trovato', noSettle: 'Niente da saldare.', paid: 'Pagato', share: 'Quota', splitTitle: 'Conti di {name}', whoPays: 'Chi paga chi ({c}, cambio di oggi)', total: 'Totale', details: 'Dettaglio', none: 'Ancora niente', openApp: 'Apri nell’app', auto: 'Questa pagina è creata automaticamente dal viaggio condiviso. Scompare quando la condivisione termina.' },
  pt: { trip: 'Viagem', inviteGone: 'Convite não encontrado', inviteGoneSub: 'O compartilhamento pode ter terminado ou o código está errado.', joinTitle: 'Entrar em {name}', invited: 'Você foi convidado para “{name}”', inviteBody: 'Planejem juntos reservas, gastos e fotos no Tripfold.', openJoin: 'Abrir no app e entrar', getApp: 'Baixar o app (App Store)', splitOnly: 'Ver o acerto sem o app', codeHint: 'Código para “Entrar com código” no app', notFound: 'Não encontrado', noSettle: 'Nada a acertar.', paid: 'Pagou', share: 'Parte', splitTitle: 'Acerto de {name}', whoPays: 'Quem paga quem ({c}, câmbio de hoje)', total: 'Total', details: 'Detalhes', none: 'Nada ainda', openApp: 'Abrir no app', auto: 'Esta página é criada automaticamente a partir da viagem compartilhada e some quando o compartilhamento termina.' },
};
function langOf(req) {
  const a = String(req.headers['accept-language'] || '').toLowerCase();
  for (const part of a.split(',')) {
    const l = part.trim().split(';')[0];
    if (l.startsWith('zh')) return /hant|tw|hk|mo/.test(l) ? 'zh-Hant' : 'zh-Hans';
    const b = l.slice(0, 2);
    if (W[b]) return b;
  }
  return 'en';
}

/* ---------- Webページ（アプリがない人向け：招待・割り勘） ---------- */
const APP_STORE = 'https://apps.apple.com/app/id6833397163';
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function html(res, status, title, body, lang = 'en') {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#F4F3EF;color:#15171C;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif}main{max-width:520px;margin:0 auto;padding:28px 18px 48px}
.k{font-size:12px;letter-spacing:.12em;color:#8A8F98;font-weight:700}h1{font-size:26px;margin:4px 0 18px;line-height:1.3}.card{background:#fff;border-radius:18px;padding:16px 18px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #EEE}.row:last-child{border:0}.amt{font-weight:800;white-space:nowrap}.pink{color:#D6336C}.sub{color:#8A8F98;font-size:13px}
.btn{display:block;text-align:center;background:#15171C;color:#fff;text-decoration:none;font-weight:800;padding:15px;border-radius:14px;margin:10px 0}.btn2{background:#fff;color:#15171C;border:1px solid #DDD}
.code{font:800 24px ui-monospace,Menlo,monospace;letter-spacing:.12em;text-align:center;padding:10px}</style></head><body><main>${body}<p class="sub" style="margin-top:28px">Tripfold</p></main></body></html>`);
}
const pretty = (c) => c.slice(0, 4) + '-' + c.slice(4);

// 為替（6時間ごとに取り直す）
const rateCache = new Map();
async function ratesFor(base) {
  const hit = rateCache.get(base);
  if (hit && now() - hit.at < 6 * 3600 * 1000) return hit.rates;
  try {
    const r = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    if (j && j.rates) {
      rateCache.set(base, { at: now(), rates: { ...j.rates, [base]: 1 } });
      return rateCache.get(base).rates;
    }
  } catch {}
  return hit ? hit.rates : { [base]: 1 };
}
const DEC0 = ['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'ISK', 'HUF', 'TWD'];
const fmt = (n, c) => {
  const d = DEC0.includes(c) ? 0 : 2;
  return `${c} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
/** アプリと同じ割り勘の計算（母国通貨） */
function settleTrip(t, base, rates) {
  const toHome = (v, c) => (!c || c === base ? v : rates[c] ? v / rates[c] : 0);
  const ids = (t.members || []).map((m) => m.id);
  const paid = {}, owe = {};
  ids.forEach((i) => ((paid[i] = 0), (owe[i] = 0)));
  const items = [
    ...(t.bookings || []).filter((b) => !b.cancelled).map((b) => ({ v: b.price ? toHome(Number(b.price), b.currency) : 0, by: b.paidBy, sw: b.splitWith })),
    ...(t.expenses || []).map((e) => ({ v: e.rate && e.currency !== base ? Number(e.amount) * Number(e.rate) : toHome(Number(e.amount), e.currency), by: e.paidBy, sw: e.splitWith })),
  ];
  let total = 0;
  items.forEach((x) => {
    if (!x.v) return;
    const payer = x.by && ids.includes(x.by) ? x.by : ids[0];
    const among = (x.sw && x.sw.length ? x.sw : ids).filter((i) => ids.includes(i));
    if (!payer || !among.length) return;
    total += x.v;
    paid[payer] += x.v;
    among.forEach((i) => (owe[i] += x.v / among.length));
  });
  const bal = ids.map((i) => ({ id: i, v: paid[i] - owe[i] }));
  const cred = bal.filter((b) => b.v > 0.5).sort((a, b) => b.v - a.v);
  const debt = bal.filter((b) => b.v < -0.5).sort((a, b) => a.v - b.v);
  const pay = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(-debt[i].v, cred[j].v);
    pay.push({ from: debt[i].id, to: cred[j].id, amount: x });
    debt[i].v += x;
    cred[j].v -= x;
    if (debt[i].v > -0.5) i++;
    if (cred[j].v < 0.5) j++;
  }
  return { total, paid, owe, pay };
}

/* ---------- 受付 ---------- */
const wbb = require('./wbb')({ DATA, send, readBody, limited });

const server = http.createServer(async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'OPTIONS') return send(res, 204, undefined);
    if (limited(ip, 'all', 300, 60 * 1000)) return send(res, 429, { error: 'too many requests' });

    if (p === '/health') return send(res, 200, { ok: true, app: 'tripfold', time: new Date().toISOString() });
    // 旅行ガイド（/guides と /guides/<slug>）
    if (req.method === 'GET' && (p === '/guides' || /^\/guides\/[a-z0-9-]+$/.test(p))) {
      const name = p === '/guides' ? 'index' : p.slice(8);
      const f = path.join(__dirname, 'public', 'guides', name + '.html');
      if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
      return fs.createReadStream(f).pipe(res);
    }
    // 紹介ページ・プライバシーポリシー
    if ((p === '/' || p === '/privacy') && req.method === 'GET') {
      const f = path.join(__dirname, 'public', p === '/' ? 'index.html' : 'privacy.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
      return fs.createReadStream(f).pipe(res);
    }

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


    // 招待ページ：LINEなどで押せるURL → アプリを開く
    m = p.match(/^\/j\/([0-9A-Za-z-]{8,9})$/);
    if (m && req.method === 'GET') {
      const L = langOf(req);
      const w = W[L];
      const code = normCode(m[1]);
      const doc = CODE_RE.test(code) ? await loadDoc(code) : null;
      if (!doc) return html(res, 404, 'Tripfold', `<h1>${w.inviteGone}</h1><p>${w.inviteGoneSub}</p>`, L);
      const deep = `tripfold://join?c=${code}`;
      const nm = esc(doc.trip.name || w.trip);
      return html(res, 200, w.joinTitle.replace('{name}', doc.trip.name || w.trip), `<div class="k">INVITE</div><h1>${w.invited.replace('{name}', nm)}</h1>
<div class="card"><p>${w.inviteBody}</p><a class="btn" href="${deep}">${w.openJoin}</a>
<a class="btn btn2" href="${APP_STORE}">${w.getApp}</a><a class="btn btn2" href="/s/${code}">${w.splitOnly}</a></div>
<div class="card"><div class="sub">${w.codeHint}</div><div class="code">${pretty(code)}</div></div>
<script>setTimeout(function(){location.href=${JSON.stringify(deep)}},300)</script>`, L);
    }

    // 割り勘ページ（アプリ不要）
    m = p.match(/^\/s\/([0-9A-Za-z-]{8,9})$/);
    if (m && req.method === 'GET') {
      const L = langOf(req);
      const w = W[L];
      const code = normCode(m[1]);
      const doc = CODE_RE.test(code) ? await loadDoc(code) : null;
      if (!doc) {
        if (limited(ip, 'miss', 30, 10 * 60 * 1000)) return send(res, 429, { error: 'too many tries' });
        return html(res, 404, 'Tripfold', `<h1>${w.notFound}</h1>`, L);
      }
      const t = doc.trip;
      const base = /^[A-Z]{3}$/.test(url.searchParams.get('c') || '') ? url.searchParams.get('c') : 'JPY';
      const st = settleTrip(t, base, await ratesFor(base));
      const name = (id) => esc(((t.members || []).find((x) => x.id === id) || {}).name || '?');
      const pays = st.pay.length
        ? st.pay.map((x) => `<div class="row"><span>${name(x.from)} → ${name(x.to)}</span><span class="amt pink">${fmt(x.amount, base)}</span></div>`).join('')
        : `<p>${w.noSettle}</p>`;
      const per = (t.members || []).map((mm) => `<div class="row"><span>${esc(mm.name)}</span><span class="sub">${w.paid} ${fmt(st.paid[mm.id] || 0, base)} / ${w.share} ${fmt(st.owe[mm.id] || 0, base)}</span></div>`).join('');
      const exps = [...(t.bookings || []).filter((b) => b.price && !b.cancelled).map((b) => ({ d: b.start, n: b.title, a: b.price, c: b.currency || base, by: b.paidBy })), ...(t.expenses || []).map((e) => ({ d: e.date, n: e.title, a: e.amount, c: e.currency, by: e.paidBy }))]
        .sort((a, b) => String(a.d).localeCompare(String(b.d)))
        .map((x) => `<div class="row"><span>${esc(x.n || '')}<br><span class="sub">${esc(x.d || '')} · ${name(x.by || (t.members || [])[0]?.id)}</span></span><span class="amt">${fmt(x.a, x.c)}</span></div>`)
        .join('');
      const nm = esc(t.name || w.trip);
      return html(res, 200, w.splitTitle.replace('{name}', t.name || w.trip), `<div class="k">SETTLE UP</div><h1>${w.splitTitle.replace('{name}', nm)}</h1>
<div class="card"><div class="sub">${w.whoPays.replace('{c}', base)}</div>${pays}</div>
<div class="card"><div class="sub">${w.total} ${fmt(st.total, base)}</div>${per}</div>
<div class="card"><div class="sub">${w.details}</div>${exps || `<p>${w.none}</p>`}</div>
<a class="btn" href="tripfold://join?c=${code}">${w.openApp}</a><p class="sub">${w.auto}</p>`, L);
    }

    // 名前で場所を探す（近くの地点があればその周りに絞る）
    if (p === '/v1/geo/search' && req.method === 'GET') {
      if (limited(ip, 'geosearch', 400, 60 * 60 * 1000)) return send(res, 429, { error: 'too many' });
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 200);
      if (!q) return send(res, 400, { error: 'q required' });
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lng'));
      const near = isFinite(lat) && isFinite(lng) && url.searchParams.has('lat') ? { lat, lng } : null;
      const key = 'n6:' + geoKey(q) + (near ? `@${lat.toFixed(1)},${lng.toFixed(1)}` : '');
      if (key in geo) return geo[key] ? send(res, 200, geo[key]) : send(res, 404, { error: 'not found' });
      const lang = String(req.headers['accept-language'] || 'en').slice(0, 40);
      const head = cleanPlace(q.split(/\s*,\s*/)[0] || q);
      if (GENERIC.test(head) || !head) {
        geo[key] = null;
        return send(res, 404, { error: 'not found' });
      }
      let g = /[\u3040-\u30ff\u4e00-\u9fff]/.test(q) && JA_ADDR.test(q) ? await gsiGeo(q) : null;
      if (!g) g = await nominatim(q, near, lang);
      if (g === undefined) return send(res, 503, { error: 'lookup failed' });
      // 見つからなければ：動詞を外した名前 → Wikipedia の座標 の順に試す
      const cq = cleanPlace(q);
      if (!g && cq && cq !== q) g = (await nominatim(cq, near, lang)) || null;
      // 「店名, 住所」の形で見つからないとき：住所だけ → 店名だけ（＋最後の町名）で探す
      const parts = (cq || q).split(/\s*,\s*/).filter(Boolean);
      if (!g && parts.length >= 2) {
        const addr = parts.slice(1).join(', ');
        if (/\d/.test(addr)) g = (await nominatim(addr, near, lang)) || null;
        if (!g) g = (await nominatim(`${parts[0]}, ${parts[parts.length - 1]}`, near, lang)) || null;
      }
      if (!g) g = await wikiGeo(parts[0] || cq || q, near);
      if (Object.keys(geo).length < 300000) {
        geo[key] = g;
        saveGeoSoon();
      }
      return g ? send(res, 200, g) : send(res, 404, { error: 'not found' });
    }

    // World Budget Book（バックアップ・共有の家計簿）
    if (p.startsWith('/wbb/')) return await wbb(req, res, url, p, ip);

    // 2地点の道のり（地図に実際の道を描く）
    if (p === '/v1/geo/route' && req.method === 'GET') {
      if (limited(ip, 'georoute', 600, 60 * 60 * 1000)) return send(res, 429, { error: 'too many' });
      const mode = url.searchParams.get('mode') === 'foot' ? 'foot' : 'car';
      const pt = (k) => {
        const [la, ln] = String(url.searchParams.get(k) || '').split(',').map(Number);
        return isFinite(la) && isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180 ? { lat: Math.round(la * 1e4) / 1e4, lng: Math.round(ln * 1e4) / 1e4 } : null;
      };
      const a = pt('from');
      const b = pt('to');
      if (!a || !b) return send(res, 400, { error: 'bad' });
      const km0 = Math.hypot(a.lat - b.lat, (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180)) * 111;
      if (km0 > (mode === 'foot' ? 8 : 400)) return send(res, 404, { error: 'too far' });
      const key = `${mode}|${a.lat},${a.lng}|${b.lat},${b.lng}`;
      if (routes.has(key)) return routes.get(key) ? send(res, 200, routes.get(key)) : send(res, 404, { error: 'not found' });
      const r = await osmRoute(mode, a, b);
      if (r === undefined) return send(res, 503, { error: 'lookup failed' });
      if (routes.size > 20000) routes.delete(routes.keys().next().value);
      routes.set(key, r);
      return r ? send(res, 200, r) : send(res, 404, { error: 'not found' });
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
module.exports = { mergeTrip, settleTrip };
