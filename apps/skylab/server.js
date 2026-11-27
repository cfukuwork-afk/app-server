// SkyLab のデータ収集係 — 外部ライブラリなし・Node.js 22
//  - 英国の数地点について、Open-Meteo の予報を毎時、取得時刻つきでそのまま保存する（書き換えない）
//  - NOAA SWPC の太陽風（磁場・プラズマ）と Kp、OVATION の出力を保存する
//  - あとでバックテストするとき「その時点で手に入ったもの」だけを使えるよう、取得時刻・URL・応答の状態を必ず残す
//  - Open-Meteo の無料APIは非商用のみ。今は研究目的の収集。公開・課金の前に有料プランか自前取得へ切り替える
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.PORT || 3106);
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const RAW = path.join(DATA, 'raw');
const api = require('./api')(DATA);
const page = (t, b) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title><style>body{font-family:-apple-system,system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;line-height:1.7;color:#222}h1{font-size:22px}h2{font-size:17px;margin-top:28px}textarea,input{width:100%;font-size:16px;padding:8px;box-sizing:border-box}button{font-size:16px;padding:10px 20px;margin-top:10px}</style><h1>${t}</h1>${b}`;
const PAGES = {
  '/': page('SkyLab', '<p>空の現象（オーロラ・星空・夕焼け・虹など）が、いつ・どこで・どの方向に見えるかを予測するアプリです。<br>SkyLab forecasts when and where you can see sky phenomena.</p><p><a href="/privacy">プライバシーポリシー / Privacy</a> ・ <a href="/terms">利用規約 / Terms</a> ・ <a href="/support">サポート / Support</a></p>'),
  '/privacy': page('SkyLab プライバシーポリシー / Privacy Policy', `<p>最終更新：2026年11月27日</p>
<h2>集める情報</h2><p>予報を出すために、端末の位置（緯度・経度）を送ります。サーバーでは予報の計算に使い、通知を登録した場合は0.1度（約10km）に丸めた位置だけを保存します。<br>「見えた／見えなかった」報告では、現象の種類、時刻、0.01度（約1km）に丸めた位置、アプリが表示していた予報を保存し、予報の精度の検証と改善に使います。<br>通知のための端末トークンと、端末内で作るランダムなIDを保存します。氏名・メールアドレス・広告IDは集めません。</p>
<h2>第三者への提供</h2><p>個人を特定できる形で第三者に提供・販売しません。通知の配信には Expo（米国）のサービスを使います。予報の元データとして、位置（丸めたもの）を気象データの提供元（Open-Meteo）に送ります。</p>
<h2>削除</h2><p>アプリの設定から「データを削除」で、サーバー上の登録情報を削除できます。報告は個人と結びつかない形で研究に使い続けることがあります。</p>
<h2>English</h2><p>We send your device location to compute forecasts. If you enable alerts we store your location rounded to 0.1°. Sighting reports store the phenomenon, time, location rounded to 0.01° and the forecast shown, used to verify and improve accuracy. We store a push token and a random in-app ID. We do not collect names, emails or advertising IDs, and we do not sell data. Push delivery uses Expo; forecast data comes from Open-Meteo, NOAA SWPC. You can delete your registration in Settings.</p>
<p>お問い合わせ / Contact: <a href="/support">サポート</a></p>`),
  '/terms': page('SkyLab 利用規約 / Terms', `<p>SkyLab の予報は、気象・宇宙天気のデータと計算による目安です。現象が必ず見えることを保証しません。「実験中」と表示した項目は、精度を検証している途中の機能です。観測の際は、天候・交通・寒さなど安全に十分注意してください。予報に基づく判断による損害について、開発者は責任を負いません。</p>
<p>SkyLab forecasts are estimates based on weather and space-weather data and are not guaranteed. Items marked "Experimental" are still being validated. Stay safe when observing. The developer is not liable for decisions made based on the forecasts.</p>
<p>Apple の標準利用規約（EULA）も適用されます / Apple's standard EULA applies: <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/">https://www.apple.com/legal/internet-services/itunes/dev/stdeula/</a></p>`),
  '/support': page('SkyLab サポート / Support', '<p>ご質問・不具合・ご要望はこちらからお送りください。返信が必要な場合は連絡先も書いてください。<br>Questions, bugs, or ideas — send them here. Include contact details if you want a reply.</p><form method="post"><textarea name="m" rows="8" required></textarea><button>送信 / Send</button></form>'),
};
fs.mkdirSync(RAW, { recursive: true });

// 初期の検証地点（英国）。追加するときは名前を変えない（ファイル名に使う）
const POINTS = [
  { id: 'cambridge', lat: 52.2053, lon: 0.1218 },
  { id: 'london', lat: 51.5072, lon: -0.1276 },
  { id: 'keswick', lat: 54.6013, lon: -3.1347 }, // 湖水地方（霧・雲海・虹）
  { id: 'edinburgh', lat: 55.9533, lon: -3.1883 },
  { id: 'lerwick', lat: 60.1546, lon: -1.1450 }, // シェトランド（オーロラ）
  { id: 'snowdon', lat: 53.0685, lon: -4.0763 }, // 山岳（雲海）
  // フィンランド・ラップランド（オーロラ。2027年1月の現地検証）
  { id: 'rovaniemi', lat: 66.5039, lon: 25.7294, models: 'ecmwf_ifs025,gfs_seamless,icon_seamless,metno_seamless' },
  { id: 'saariselka', lat: 68.4183, lon: 27.4136, models: 'ecmwf_ifs025,gfs_seamless,icon_seamless,metno_seamless' },
  { id: 'kittila', lat: 67.6600, lon: 24.9100, models: 'ecmwf_ifs025,gfs_seamless,icon_seamless,metno_seamless' },
  { id: 'kilpisjarvi', lat: 69.0450, lon: 20.7950, models: 'ecmwf_ifs025,gfs_seamless,icon_seamless,metno_seamless' },
  { id: 'helsinki', lat: 60.1699, lon: 24.9384, models: 'ecmwf_ifs025,gfs_seamless,icon_seamless,metno_seamless' },
];
const HOURLY = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'precipitation', 'rain', 'showers', 'direct_radiation', 'diffuse_radiation', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'visibility', 'wind_speed_10m', 'wind_direction_10m', 'surface_pressure', 'cape', 'temperature_850hPa', 'relative_humidity_850hPa', 'temperature_925hPa', 'relative_humidity_925hPa'];

const JOBS = [
  ...POINTS.map((p) => ({
    id: 'om_' + p.id,
    every: 60, // 分
    // 複数モデルを並べて保存（あとで地域・季節・リードタイム別の重み付けを学習するため）
    url: () => 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({ latitude: p.lat, longitude: p.lon, hourly: HOURLY.join(','), models: p.models || 'ecmwf_ifs025,gfs_seamless,icon_seamless,ukmo_seamless', timezone: 'GMT', forecast_days: 3 }).toString(),
  })),
  // モデルの最新実行の初期時刻（予報の発行時刻を記録するため）
  { id: 'om_meta_ecmwf', every: 60, url: () => 'https://api.open-meteo.com/data/ecmwf_ifs025/static/meta.json' },
  { id: 'om_meta_ukmo', every: 60, url: () => 'https://api.open-meteo.com/data/ukmo_global_deterministic_10km/static/meta.json' },
  { id: 'om_meta_gfs', every: 60, url: () => 'https://api.open-meteo.com/data/ncep_gfs025/static/meta.json' },
  { id: 'om_meta_icon', every: 60, url: () => 'https://api.open-meteo.com/data/dwd_icon/static/meta.json' },
  // 実況（正解データ）：空港の METAR（視程・天気現象・雲）。aviationweather.gov（米国政府）。地点の近くの空港
  { id: 'metar_uk', every: 60, url: () => 'https://aviationweather.gov/api/data/metar?' + new URLSearchParams({ ids: 'EGSC,EGLL,EGNC,EGPH,EGPB,EGOV', format: 'json', hours: 3 }).toString() },
  // 世界中の METAR（全空港の最新、毎分更新のまとめファイル）。正解データの世界版
  { id: 'metar_world', every: 60, url: () => 'https://aviationweather.gov/data/cache/metars.cache.csv.gz', raw: true, after: (b) => pickWorld(b) },
  // 宇宙天気（NOAA SWPC）
  // 太陽風（DSCOVR 等、1分値）。旧 /products/solar-wind/ は廃止（404）。ファイルは重なりを持たせて3時間ごとに保存
  { id: 'swpc_rtsw_mag', every: 180, url: () => 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json' },
  { id: 'swpc_rtsw_wind', every: 180, url: () => 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json' },
  { id: 'swpc_kp', every: 180, url: () => 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json' },
  { id: 'swpc_kp_forecast', every: 180, url: () => 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json', after: (b) => api.setKpForecast(b) },
  { id: 'swpc_ovation', every: 15, url: () => 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', after: (b) => api.setOvation(b) },
];

// 世界の検証地点：METAR のある空港から、緯度経度 6°のマスごとに1か所を選ぶ（陸と島をまんべんなく）。1日1回選び直す
const WORLD_FILE = path.join(DATA, 'world_points.json');
let WORLD = [];
try { WORLD = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8')); } catch {}
let worldPickedAt = 0;
function pickWorld(gzBody) {
  if (Date.now() - worldPickedAt < 20 * 3600e3 && WORLD.length) return;
  try {
    const lines = zlib.gunzipSync(gzBody).toString('utf8').split('\n');
    const hi = lines.findIndex((l) => l.startsWith('raw_text,'));
    if (hi < 0) return;
    const head = lines[hi].split(',');
    const iId = head.indexOf('station_id'), iLat = head.indexOf('latitude'), iLon = head.indexOf('longitude');
    const cells = new Map();
    for (const l of lines.slice(hi + 1)) {
      const c = l.split(',');
      const id = c[iId], lat = Number(c[iLat]), lon = Number(c[iLon]);
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const key = Math.floor((lat + 90) / 6) + ':' + Math.floor((lon + 180) / 6);
      if (!cells.has(key)) cells.set(key, { id, lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 });
    }
    // マスの順（南→北、西→東）に並べ、上限600。空港の記号順で切ると地域が偏るので使わない
    const pts = [...cells.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e[1]).slice(0, 600);
    if (pts.length > 50) {
      WORLD = pts;
      worldPickedAt = Date.now();
      fs.writeFileSync(WORLD_FILE, JSON.stringify(WORLD));
    }
  } catch (e) {
    console.error('pickWorld', e.message);
  }
}
const WORLD_HOURLY = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'precipitation', 'direct_radiation', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'visibility', 'wind_speed_10m', 'cape'];
async function runWorld() {
  // 6時間ごと（モデルの実行の間隔に合わせる）。50地点ずつまとめて1回の問い合わせに
  for (let i = 0; i < WORLD.length; i += 50) {
    const b = WORLD.slice(i, i + 50);
    await run({ id: 'om_world_' + String(i / 50).padStart(2, '0'), url: () => 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({ latitude: b.map((x) => x.lat).join(','), longitude: b.map((x) => x.lon).join(','), hourly: WORLD_HOURLY.join(','), models: 'ecmwf_ifs025,gfs_seamless', timezone: 'GMT', forecast_days: 3 }).toString() });
    await new Promise((r) => setTimeout(r, 20000));
  }
}
setTimeout(() => {
  runWorld();
  setInterval(runWorld, 6 * 3600e3).unref();
}, 15 * 60e3).unref(); // 起動の15分後（先に METAR から地点を選ぶ）

const state = {}; // id -> { last, ok, status, bytes, err }
const day = (d) => d.toISOString().slice(0, 10);

async function run(job) {
  const url = job.url();
  const t0 = new Date();
  const s = (state[job.id] = state[job.id] || { runs: 0, fails: 0 });
  s.runs++;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'SkyLab research collector (non-commercial)' }, signal: AbortSignal.timeout(30000) });
    const body = Buffer.from(await r.arrayBuffer());
    const t1 = new Date();
    const dir = path.join(RAW, day(t1));
    fs.mkdirSync(dir, { recursive: true });
    const stem = `${job.id}_${t1.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
    // 応答の本文（失敗でも残す：欠損の理由になる）と、取得の記録
    fs.writeFileSync(path.join(dir, stem + (job.raw ? '.csv.gz' : '.json.gz')), job.raw ? body : zlib.gzipSync(body));
    if (job.after && r.ok) job.after(body);
    fs.writeFileSync(path.join(dir, stem + '.meta.json'), JSON.stringify({ job: job.id, url, requested_at: t0.toISOString(), retrieved_at: t1.toISOString(), http_status: r.status, bytes: body.length, content_type: r.headers.get('content-type') || '' }));
    Object.assign(s, { last: t1.toISOString(), status: r.status, bytes: body.length, err: r.ok ? '' : 'http ' + r.status });
    if (!r.ok) s.fails++;
  } catch (e) {
    s.fails++;
    Object.assign(s, { last: new Date().toISOString(), status: 0, err: String(e.message || e).slice(0, 200) });
    // 通信失敗も記録する（その時間は「データなし」と分かるように）
    try {
      const dir = path.join(RAW, day(new Date()));
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, '_failures.jsonl'), JSON.stringify({ job: job.id, url, at: new Date().toISOString(), error: s.err }) + '\n');
    } catch {}
  }
}

// 起動時に少しずつずらして始め、その後は決まった間隔で回す
JOBS.forEach((job, i) => {
  setTimeout(() => {
    run(job);
    setInterval(() => run(job), job.every * 60e3).unref();
  }, 5000 + i * 7000).unref();
});

// 古い生データの圧縮済みファイルは消さない（検証の元になる）。容量だけ見張る
function usage() {
  let files = 0, bytes = 0, days = 0;
  try {
    for (const d of fs.readdirSync(RAW)) {
      days++;
      for (const f of fs.readdirSync(path.join(RAW, d))) {
        files++;
        bytes += fs.statSync(path.join(RAW, d, f)).size;
      }
    }
  } catch {}
  return { days, files, mb: Math.round(bytes / 1e5) / 10 };
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p.startsWith('/api/')) {
      try { if ((await api.handle(req, res, u)) !== false) return; } catch (e) { console.error(e); return res.writeHead(500).end(); }
      return res.writeHead(404).end();
    }
    if (PAGES[p]) return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGES[p]);
    if (p === '/support' && req.method === 'POST') {
      let b = ''; req.on('data', (d) => { b += d; if (b.length > 10000) req.destroy(); });
      return req.on('end', () => { fs.appendFile(path.join(DATA, 'support.jsonl'), JSON.stringify({ at: new Date().toISOString(), body: b.slice(0, 5000) }) + '\n', () => {}); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('SkyLab', '<p>送信しました。ありがとうございます。<br>Thank you, your message was sent.</p>')); });
    }
    if (p === '/health') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    if (p === '/status') {
      // 公開してよいのは収集の状態だけ（データそのものは出さない）
      return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ jobs: state, storage: usage(), points: POINTS.map((x) => x.id), world_points: WORLD.length }, null, 1));
    }
    res.writeHead(404).end();
  })
  .listen(PORT, '127.0.0.1', () => console.log('skylab collector on', PORT));
