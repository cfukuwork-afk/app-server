"""仮説 H-R2：60 分より先では、レーダーの外挿と数値予報を混ぜると、どちらか単独より当たる。
地点（英国 20 都市、3x3 km 平均）で、t0 から L 分後〜L+60 分の平均降水強度を比べる。
 - 外挿：pysteps（LK）の 15 分おき予測の平均
 - 数値予報：Open-Meteo Historical Forecast（各ランの最初の数時間をつないだ時系列）の UKMO の 1 時間降水量
 - 混合：w(L)*外挿 + (1-w(L))*数値予報。w は事例の前半で決め、後半で評価（同じ事例で決めて評価しない）
"""
import boto3, h5py, io, json, os, random, time, urllib.parse, urllib.request, datetime as dt
import numpy as np
from botocore import UNSIGNED
from botocore.config import Config
from pyproj import CRS, Transformer
from pysteps import motion, nowcasts
s3 = boto3.client('s3', region_name='eu-west-2', config=Config(signature_version=UNSIGNED))
B = 'met-office-radar-obs-data'
os.makedirs('out', exist_ok=True)
log = open('out/blend_log.txt', 'a')
def say(*a):
    print(*a, flush=True); print(*a, file=log, flush=True)
CITIES = {'London': (51.50, -0.12), 'Manchester': (53.48, -2.24), 'Birmingham': (52.48, -1.90), 'Leeds': (53.80, -1.55), 'Glasgow': (55.86, -4.25),
          'Edinburgh': (55.95, -3.19), 'Cardiff': (51.48, -3.18), 'Bristol': (51.45, -2.59), 'Newcastle': (54.97, -1.61), 'Norwich': (52.63, 1.30),
          'Plymouth': (50.37, -4.14), 'Belfast': (54.60, -5.93), 'Aberdeen': (57.15, -2.09), 'Inverness': (57.48, -4.22), 'Cambridge': (52.20, 0.12),
          'Southampton': (50.90, -1.40), 'Exeter': (50.72, -3.53), 'Hull': (53.74, -0.33), 'Liverpool': (53.41, -2.98), 'Lerwick': (60.15, -1.15)}
GEO = None
def load(t):
    global GEO
    key = f"radar/{t:%Y/%m/%d}/{t:%Y%m%d%H%M}_ODIM_ng_radar_rainrate_composite_1km_UK.h5"
    b = s3.get_object(Bucket=B, Key=key)['Body'].read()
    with h5py.File(io.BytesIO(b), 'r') as f:
        ds = f['dataset1']; d = ds['data1']['data'][()].astype('float32')
        w = dict(ds['data1']['what'].attrs) if 'what' in ds['data1'] else dict(ds['what'].attrs)
        gain, off = float(w.get('gain', 1)), float(w.get('offset', 0)); nod, und = w.get('nodata'), w.get('undetect')
        x = d * gain + off
        if nod is not None: x[d == nod] = np.nan
        if und is not None: x[d == und] = 0
        if GEO is None:
            wh = {k: (v.decode() if isinstance(v, bytes) else v) for k, v in f['where'].attrs.items()}
            say('where', sorted(wh))
            tr = Transformer.from_crs(CRS.from_epsg(4326), CRS.from_proj4(wh['projdef']), always_xy=True)
            if 'UL_x' in wh: ux, uy = float(wh['UL_x']), float(wh['UL_y'])
            else: ux, uy = tr.transform(float(wh['UL_lon']), float(wh['UL_lat']))
            g = {}
            for c, (la, lo) in CITIES.items():
                X, Y = tr.transform(lo, la)
                g[c] = (int((uy - Y) / float(wh['yscale'])), int((X - ux) / float(wh['xscale'])))
            GEO = g
            say('grid', d.shape, {c: GEO[c] for c in list(GEO)[:3]})
    return x
def at(field, c):
    r, k = GEO[c]
    if not (1 <= r < field.shape[0] - 1 and 1 <= k < field.shape[1] - 1): return np.nan
    return float(np.nanmean(field[r - 1:r + 2, k - 1:k + 2]))
def nwp(c, day):
    la, lo = CITIES[c]
    q = urllib.parse.urlencode({'latitude': la, 'longitude': lo, 'hourly': 'precipitation', 'models': 'ukmo_seamless', 'start_date': day, 'end_date': day, 'timezone': 'GMT'})
    for i in range(4):
        try:
            with urllib.request.urlopen('https://historical-forecast-api.open-meteo.com/v1/forecast?' + q, timeout=60) as r:
                j = json.loads(r.read()); return dict(zip(j['hourly']['time'], j['hourly']['precipitation']))
        except Exception as e:
            time.sleep(5 * (i + 1))
    return {}
LEADS = [60, 120, 180]
random.seed(3)
today = dt.datetime.now(dt.UTC).replace(tzinfo=None).replace(minute=0, second=0, microsecond=0)
rows = []
for dd in sorted(random.sample(range(10, 700), int(os.environ.get('N_DAYS', '45')))):
    t0 = (today - dt.timedelta(days=dd)).replace(hour=random.choice([9, 12, 15]))
    try:
        past = [load(t0 - dt.timedelta(minutes=15 * k)) for k in (3, 2, 1, 0)]
    except Exception as e:
        say('skip', t0, e); continue
    if np.nanmean(past[-1] > 0.5) < 0.03: continue
    R0 = np.nan_to_num(np.stack(past), nan=0.0)
    V = motion.get_method('LK')(np.log10(np.maximum(R0, 0.01)))
    ext = nowcasts.get_method('extrapolation')(R0[-1], V, 16)  # 4 時間（15 分×16）
    obs = {}
    for k in range(1, 17):
        try: obs[k] = load(t0 + dt.timedelta(minutes=15 * k))
        except Exception: pass
    N = {c: nwp(c, t0.date().isoformat()) for c in CITIES}
    for L in LEADS:
        ks = [L // 15 + j for j in range(1, 5)]  # L〜L+60 分の 4 枚
        if not all(k in obs for k in ks): continue
        hr = (t0 + dt.timedelta(minutes=L + 60)).strftime('%Y-%m-%dT%H:00')  # その 1 時間の降水量（終わりの時刻に付く）
        for c in CITIES:
            o = np.nanmean([at(obs[k], c) for k in ks]); e = np.nanmean([at(np.nan_to_num(ext[k - 1]), c) for k in ks]); n = N[c].get(hr)
            if np.isfinite(o) and np.isfinite(e) and n is not None:
                rows.append({'t0': t0.isoformat(), 'L': L, 'c': c, 'obs': o, 'ext': e, 'nwp': float(n)})
    say('case', t0, 'rows', len(rows))
cases = sorted({r['t0'] for r in rows}); half = set(cases[:len(cases) // 2])
res = {'cases': len(cases), 'by_lead': {}}
for L in LEADS:
    tr = [r for r in rows if r['L'] == L and r['t0'] in half]; te = [r for r in rows if r['L'] == L and r['t0'] not in half]
    if not tr or not te: continue
    mae = lambda rs, w: float(np.mean([abs(w * r['ext'] + (1 - w) * r['nwp'] - r['obs']) for r in rs]))
    ws = [i / 20 for i in range(21)]; wbest = min(ws, key=lambda w: mae(tr, w))
    hit = lambda rs, w, th=0.5: float(np.mean([((w * r['ext'] + (1 - w) * r['nwp']) >= th) == (r['obs'] >= th) for r in rs]))
    res['by_lead'][str(L)] = {'n_test': len(te), 'w_ext': wbest, 'mae': {'extrapolation': round(mae(te, 1), 4), 'nwp': round(mae(te, 0), 4), 'blend': round(mae(te, wbest), 4)},
                              'accuracy_0.5mm': {'extrapolation': round(hit(te, 1), 4), 'nwp': round(hit(te, 0), 4), 'blend': round(hit(te, wbest), 4)}}
json.dump(res, open('out/radar_blend.json', 'w'), indent=1)
say(json.dumps(res))
