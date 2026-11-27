// SkyLab アプリ用の API（外部ライブラリなし）
//  GET  /api/sky?lat=&lon=   → 地点の時間別の雲・降水（複数モデルの平均と幅）、OVATION、Kp 予報
//  POST /api/report          → 「見えた／見えなかった」報告を保存
//  POST /api/register        → オーロラ通知の登録（地点は 0.1 度に丸めて保存）
//  ※ 重み付けは検証前なので、今は単純平均と幅（モデル間の最小〜最大）を返す。検証で勝てたら差し替える
'use strict';
const fs = require('fs');
const path = require('path');

const S = require('./engine.js'); // tabi-shiori/skylab/src/sky.ts を esbuild でまとめたもの（アプリと同じ判定）

module.exports = function makeApi(DATA, POINTS = []) {
  const PRED = path.join(DATA, 'predictions');
  // 晴れ間の確率の較正表（GitHub Actions の学習結果を、検証の数字を確かめてから calibration.json として置く）
  let calib = null, calibAt = 0;
  function calibration() {
    try {
      const f = path.join(__dirname, 'calibration.json');
      const st = fs.statSync(f);
      if (st.mtimeMs !== calibAt) { calib = JSON.parse(fs.readFileSync(f, 'utf8')); calibAt = st.mtimeMs; }
    } catch { calib = null; }
    return calib;
  }
  fs.mkdirSync(PRED, { recursive: true });
  const REPORTS = path.join(DATA, 'reports.jsonl');
  const USERS = path.join(DATA, 'users.json');
  let users = {};
  try { users = JSON.parse(fs.readFileSync(USERS, 'utf8')); } catch {}
  const saveUsers = () => fs.writeFile(USERS, JSON.stringify(users), () => {});

  // ---- OVATION（NOAA）：1度格子の値。最新を覚えておく
  let ovation = null; // { obs, fc, grid: Map 'lat,lon' -> v }
  function setOvation(buf) {
    try {
      const j = JSON.parse(buf.toString());
      const grid = new Map();
      for (const [lo, la, v] of j.coordinates) if (v > 0) grid.set(la + ',' + lo, v);
      ovation = { obs: j['Observation Time'], fc: j['Forecast Time'], grid };
    } catch (e) { console.error('ovation parse', e.message); }
  }
  let kpf = null;
  function setKpForecast(buf) {
    try {
      const rows = JSON.parse(buf.toString());
      // 形式は2通りある（旧：先頭行が見出しの配列、新：オブジェクトの配列）
      const arr = Array.isArray(rows[0]) ? rows.slice(1).map((r) => ({ time_tag: r[0], kp: r[1], observed: r[2], noaa_scale: r[3] })) : rows;
      kpf = arr.map((r) => ({ t: String(r.time_tag).replace(' ', 'T').replace(/Z?$/, 'Z'), kp: Number(r.kp ?? r.Kp), kind: r.observed, scale: r.noaa_scale ?? null })).filter((r) => Number.isFinite(r.kp));
    } catch (e) { console.error('kp parse', e.message); }
  }
  const R = 6371;
  const rad = Math.PI / 180;
  function dist(a, b, c, d) { // 大円距離 km
    const x = Math.sin((c - a) * rad / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin((d - b) * rad / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function bearing(a, b, c, d) {
    const y = Math.sin((d - b) * rad) * Math.cos(c * rad);
    const x = Math.cos(a * rad) * Math.sin(c * rad) - Math.sin(a * rad) * Math.cos(c * rad) * Math.cos((d - b) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  // 見える範囲：発光の高さ h（下端 100 km 程度）と、地平線からの仰角 e のとき、届く地表距離
  //  （球面の幾何：観測者・地心・発光点の三角形）。仰角 5 度以上を「見える」とする
  function reachKm(h = 100, eDeg = 5) {
    const e = eDeg * rad;
    const beta = Math.acos((R / (R + h)) * Math.cos(e)) - e; // 地心角
    return R * beta;
  }
  function auroraAt(lat, lon) {
    if (!ovation) return null;
    const reach = reachKm();
    let over = ovation.grid.get(Math.round(lat) + ',' + ((Math.round(lon) + 360) % 360)) || 0;
    let best = { v: 0, km: null, dir: null };
    for (let la = Math.floor(lat - 7); la <= Math.ceil(lat + 7); la++) {
      for (let lo = Math.floor(lon - 20); lo <= Math.ceil(lon + 20); lo++) {
        const v = ovation.grid.get(la + ',' + ((lo + 360) % 360));
        if (!v || v <= best.v) continue;
        const km = dist(lat, lon, la, lo);
        if (km <= reach) best = { v, km: Math.round(km), dir: Math.round(bearing(lat, lon, la, lo)) };
      }
    }
    return { overhead: over, visible_max: best.v, visible_km: best.km, visible_dir: best.dir, reach_km: Math.round(reach), observed: ovation.obs, valid: ovation.fc };
  }

  // ---- 予報（Open-Meteo、3モデル）：0.1度の格子で30分キャッシュ
  const cache = new Map();
  const MODELS = ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless'];
  const VARS = ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'precipitation', 'showers', 'visibility', 'temperature_2m'];
  async function weather(lat, lon) {
    const k = lat.toFixed(1) + ',' + lon.toFixed(1);
    const c = cache.get(k);
    if (c && Date.now() - c.at < 30 * 60e3) return c.v;
    const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({ latitude: lat.toFixed(1), longitude: lon.toFixed(1), hourly: VARS.join(','), models: MODELS.join(','), timezone: 'GMT', forecast_days: 3, past_hours: 2 });
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('weather ' + r.status);
    const j = await r.json();
    const H = j.hourly;
    const lim = Date.now() + 72 * 3600e3, from = Date.now() - 3 * 3600e3;
    const hours = H.time.map((t, i) => {
      const o = { t: t + ':00Z' };
      for (const v of VARS) {
        const xs = MODELS.map((m) => H[v + '_' + m]?.[i]).filter((x) => x != null);
        o[v] = xs.length ? { mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10, min: Math.min(...xs), max: Math.max(...xs), n: xs.length } : null;
      }
      return o;
    }).filter((o) => { const x = Date.parse(o.t); return x >= from && x <= lim; });
    const v = { models: MODELS, hours, retrieved_at: new Date().toISOString() };
    cache.set(k, { at: Date.now(), v });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return v;
  }

  // 太陽高度（NOAA の簡易式。通知の「暗いか」の判定用。アプリ側は精密な天文計算を使う）
  function sunAlt(lat, lon, d) {
    const jd = d / 86400000 + 2440587.5, n = jd - 2451545.0;
    const L = (280.46 + 0.9856474 * n) % 360, g = ((357.528 + 0.9856003 * n) % 360) * rad;
    const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, eps = (23.439 - 0.0000004 * n) * rad;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)), dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    const ha = ((gmst * 15 + lon) * rad - ra);
    return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
  }

  // ---- オーロラ通知：毎時、登録地点ごとに「暗い・オーロラが見える範囲に出ている・雲が少ない」を確かめる
  let pushFn = null;
  async function auroraAlerts() {
    if (!ovation || !pushFn) return;
    const msgs = [];
    const now = Date.now();
    for (const u of Object.values(users)) {
      if (!u.token || u.aurora === false) continue;
      if (u.lastAlert && now - u.lastAlert < 10 * 3600e3) continue;
      if (sunAlt(u.lat, u.lon, now) > -10) continue;
      const a = auroraAt(u.lat, u.lon);
      if (!a || a.visible_max < (u.threshold || 10)) continue;
      let cloud = null;
      try {
        const w = await weather(u.lat, u.lon);
        const h = w.hours.find((x) => Math.abs(Date.parse(x.t) - now) < 3600e3);
        cloud = h?.cloud_cover?.mean;
      } catch {}
      if (cloud != null && cloud > 60) continue;
      u.lastAlert = now;
      const ja = u.lang === 'ja';
      msgs.push({ to: u.token, sound: 'default', title: ja ? 'オーロラのチャンス' : 'Aurora chance', body: ja ? `いま${dirName(a.visible_dir, ja)}の空にオーロラが出ている予報です（雲 ${cloud ?? '?'}%）` : `Aurora forecast in the ${dirName(a.visible_dir, ja)} sky now (cloud ${cloud ?? '?'}%)`, data: { t: 'aurora' } });
    }
    if (msgs.length) { saveUsers(); pushFn(msgs); }
  }
  function dirName(d, ja) {
    if (d == null) return ja ? '真上' : 'overhead';
    const J = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'], E = ['northern', 'north-eastern', 'eastern', 'south-eastern', 'southern', 'south-western', 'western', 'north-western'];
    const i = Math.round(d / 45) % 8;
    return ja ? J[i] : E[i];
  }
  async function push(msgs) {
    for (let i = 0; i < msgs.length; i += 90) {
      try {
        const r = await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msgs.slice(i, i + 90)), signal: AbortSignal.timeout(10000) });
        const j = await r.json();
        (j.data || []).forEach((d, k) => {
          if (d.details?.error === 'DeviceNotRegistered') for (const u of Object.values(users)) if (u.token === msgs[i + k].to) u.token = null;
        });
      } catch (e) { console.error('push', e.message); }
    }
    saveUsers();
  }
  pushFn = push;
  setInterval(() => auroraAlerts().catch((e) => console.error(e)), 20 * 60e3).unref();

  // ---- 予測の記録：毎時、決まった地点について、アプリと同じ判定の結果と入力を保存する（上書きしない）
  async function logPredictions() {
    const issued = new Date();
    const file = path.join(PRED, issued.toISOString().slice(0, 10) + '.jsonl');
    for (const pt of POINTS) {
      try {
        const w = await weather(pt.lat, pt.lon);
        const d = { weather: w, aurora: auroraAt(pt.lat, pt.lon), kp_forecast: kpf, calibration: calibration() };
        const items = S.withProb(S.today(pt.lat, pt.lon, d, issued).concat(S.goldenBlue(pt.lat, pt.lon, w, issued)), pt.lat, pt.lon, d, issued);
        const rec = { issued_at: issued.toISOString(), engine: S.ENGINE_VERSION, point: pt.id, lat: pt.lat, lon: pt.lon,
          inputs: { weather_retrieved_at: w.retrieved_at, models: w.models, hours: w.hours.filter((h) => Date.parse(h.t) <= issued.getTime() + 36 * 3600e3), aurora: d.aurora, kp: kpf },
          outputs: items };
        fs.appendFileSync(file, JSON.stringify(rec) + '\n');
      } catch (e) { fs.appendFileSync(file, JSON.stringify({ issued_at: issued.toISOString(), point: pt.id, error: String(e.message || e) }) + '\n'); }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  setTimeout(() => { logPredictions(); setInterval(logPredictions, 3600e3).unref(); }, 3 * 60e3).unref();

  // ---- HTTP
  const num = (x, lo, hi) => { const v = Number(x); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
  function body(req) {
    return new Promise((ok) => { let s = ''; req.on('data', (d) => { s += d; if (s.length > 20000) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(s)); } catch { ok(null); } }); });
  }
  const send = (res, code, o) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(o));
  const PHENOMENA = ['aurora', 'sunset', 'sunrise', 'rainbow', 'doublerainbow', 'stars', 'milkyway', 'meteor', 'moon', 'goldenhour', 'bluehour', 'halo', 'other'];

  async function handle(req, res, u) {
    const p = u.pathname;
    if (p === '/api/sky' && req.method === 'GET') {
      const lat = num(u.searchParams.get('lat'), -90, 90), lon = num(u.searchParams.get('lon'), -180, 180);
      if (lat == null || lon == null) return send(res, 400, { error: 'lat/lon' });
      let w = null, err = null;
      try { w = await weather(lat, lon); } catch (e) { err = String(e.message); }
      return send(res, 200, { lat, lon, issued_at: new Date().toISOString(), engine: S.ENGINE_VERSION, weather: w, weather_error: err, aurora: auroraAt(lat, lon), kp_forecast: kpf, calibration: calibration(), note: 'blend=simple mean (not yet validated)' });
    }
    if (p === '/api/report' && req.method === 'POST') {
      const b = await body(req);
      const lat = num(b?.lat, -90, 90), lon = num(b?.lon, -180, 180);
      const OUT = ['seen', 'looked_not_seen', 'clouded', 'not_observed'];
      if (!b || !PHENOMENA.includes(b.phenomenon) || !OUT.includes(b.outcome) || lat == null || lon == null) return send(res, 400, { error: 'bad report' });
      // 報告の時点でサーバーが持っている入力（その地点の予報の写し・オーロラ予報）を、上書きせずに一緒に残す
      const k = lat.toFixed(1) + ',' + lon.toFixed(1);
      const c = cache.get(k);
      const now = Date.now();
      const inputs = c ? { weather_retrieved_at: c.v.retrieved_at, models: c.v.models, hours: c.v.hours.filter((h) => Math.abs(Date.parse(h.t) - now) <= 6 * 3600e3) } : null;
      const rec = {
        received_at: new Date().toISOString(), observed_at: typeof b.at === 'string' ? b.at.slice(0, 30) : null,
        phenomenon: b.phenomenon, outcome: b.outcome,
        label: b.outcome === 'seen' ? 1 : b.outcome === 'looked_not_seen' ? 0 : null, // 学習用：観測していない・雲で遮られたは「発生しなかった」に使わない
        lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, accuracy_m: num(b.accuracy, 0, 1e6),
        strength: num(b.strength, 1, 3), beauty: num(b.beauty, 1, 5), dir: num(b.dir, 0, 360),
        photo_consent: b.photo_consent === true,
        user: String(b.user || '').slice(0, 40), app: String(b.app || '').slice(0, 20), engine: String(b.engine || '').slice(0, 20), server_engine: S.ENGINE_VERSION,
        shown: b.shown && typeof b.shown === 'object' ? b.shown : null, shown_issued_at: typeof b.issued_at === 'string' ? b.issued_at.slice(0, 30) : null,
        inputs, aurora_input: auroraAt(lat, lon), kp_input: kpf ? kpf.filter((x) => Math.abs(Date.parse(x.t) - now) <= 12 * 3600e3) : null,
      };
      const line = JSON.stringify(rec);
      if (line.length > 200000) return send(res, 413, { error: 'too large' });
      fs.appendFile(REPORTS, line + '\n', () => {});
      return send(res, 200, { ok: true });
    }
    if (p === '/api/geo' && req.method === 'GET') {
      const q = String(u.searchParams.get('q') || '').slice(0, 80).trim();
      if (q.length < 2) return send(res, 200, { results: [] });
      try {
        const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?' + new URLSearchParams({ name: q, count: 8, language: u.searchParams.get('lang') === 'ja' ? 'ja' : 'en', format: 'json' }), { signal: AbortSignal.timeout(10000) });
        const j = await r.json();
        return send(res, 200, { results: (j.results || []).map((x) => ({ name: x.name, admin: x.admin1 || '', country: x.country || '', lat: x.latitude, lon: x.longitude })) });
      } catch { return send(res, 502, { results: [] }); }
    }
    if (p === '/api/register' && req.method === 'POST') {
      const b = await body(req);
      const id = String(b?.user || '').slice(0, 40);
      const lat = num(b?.lat, -90, 90), lon = num(b?.lon, -180, 180);
      if (!id || lat == null || lon == null) return send(res, 400, { error: 'bad' });
      const prev = users[id] || {};
      users[id] = { ...prev, token: typeof b.token === 'string' ? b.token.slice(0, 200) : prev.token || null, lat: Math.round(lat * 10) / 10, lon: Math.round(lon * 10) / 10, lang: b.lang === 'ja' ? 'ja' : 'en', aurora: b.aurora !== false, threshold: num(b.threshold, 1, 100) || 10, at: new Date().toISOString() };
      saveUsers();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/delete' && req.method === 'POST') {
      const b = await body(req);
      delete users[String(b?.user || '')];
      saveUsers();
      return send(res, 200, { ok: true });
    }
    return false;
  }
  return { handle, setOvation, setKpForecast, auroraAt, reachKm };
};
