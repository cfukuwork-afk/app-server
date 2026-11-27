"""SkyLab 学習ジョブ（GitHub Actions で実行）
1) Open-Meteo Previous Runs API から「当時出ていた予報」（1〜5日前に出た予報）を4モデル分取得
2) Iowa Environmental Mesonet の METAR 過去データから実況を取得
3) 時刻で突き合わせ、前半期間で学習・後半期間で検証（期間で分けるので未来の情報は混ざらない）
4) 単一モデル／単純平均／SkyLab 重み付け（blend）／勾配ブースティング（GBM）の誤差を比べ results/ に保存
"""
import csv, gzip, io, json, math, os, sys, time, urllib.parse, urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(__file__))
from blend import Blender, Sample, evaluate

START, END = os.environ.get('START', '2024-03-01'), os.environ.get('END', '2026-10-31')
SPLIT = os.environ.get('SPLIT', '2025-09-01')          # これより前で学習、以後で検証
STATIONS = os.environ.get('STATIONS', 'EGSC,EGLL,EGPH,EGPB,EGCC,EGGD,EGAA,EGPD,EGBB,EGNT,EGHH,EGPK').split(',')
MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'ukmo_seamless']
LEADS = [1, 2, 3, 5]
VARS = {'temperature_2m': 'tmpc', 'wind_speed_10m': 'wind_ms'}
OUT = os.environ.get('OUT', 'results')
os.makedirs(OUT + '/cache', exist_ok=True)
log = open(OUT + '/log.txt', 'a')
def say(*a):
    print(*a); print(*a, file=log); log.flush()

def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'SkyLab research'}), timeout=120) as r:
                b = r.read()
                return gzip.decompress(b) if b[:2] == b'\x1f\x8b' else b
        except Exception as e:
            say('retry', i, url[:120], e); time.sleep(10 * (i + 1))
    raise RuntimeError('failed ' + url)

def cached(name, url):
    p = f'{OUT}/cache/{name}'
    if os.path.exists(p):
        return open(p, 'rb').read()
    b = get(url); open(p, 'wb').write(b); return b

# 観測点の座標（IEM のメタデータ）
meta = json.loads(cached('GB__ASOS.json', 'https://mesonet.agron.iastate.edu/geojson/network/GB__ASOS.geojson'))
coords = {f['properties']['sid']: f['geometry']['coordinates'] for f in meta['features']}
STATIONS = [s for s in STATIONS if s in coords]
say('stations', STATIONS)

def obs(st):
    d0, d1 = datetime.fromisoformat(START), datetime.fromisoformat(END) + timedelta(days=1)
    q = urllib.parse.urlencode([('station', st), ('data', 'tmpf'), ('data', 'sknt'), ('tz', 'Etc/UTC'), ('format', 'onlycomma'),
        ('latlon', 'no'), ('missing', 'empty'), ('trace', 'empty'), ('report_type', '3'), ('report_type', '4'),
        ('year1', d0.year), ('month1', d0.month), ('day1', d0.day), ('year2', d1.year), ('month2', d1.month), ('day2', d1.day)])
    txt = cached(f'obs_{st}.csv', 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?' + q).decode()
    best = {}  # 正時 → (時刻差分, 値)  正時の ±15 分以内で最も近い報告
    for r in csv.DictReader(io.StringIO(txt)):
        try:
            t = datetime.strptime(r['valid'], '%Y-%m-%d %H:%M')
        except Exception:
            continue
        h = (t + timedelta(minutes=30)).replace(minute=0)
        dm = abs((t - h).total_seconds()) / 60
        if dm > 15:
            continue
        v = {}
        if r.get('tmpf'):
            v['tmpc'] = (float(r['tmpf']) - 32) * 5 / 9
        if r.get('sknt'):
            v['wind_ms'] = float(r['sknt']) * 0.514444
        if v and (h not in best or dm < best[h][0]):
            best[h] = (dm, v)
    return {h: v for h, (dm, v) in best.items()}

def fcst(st):
    lon, lat = coords[st][:2]
    hourly = [f'{v}_previous_day{l}' for v in VARS for l in LEADS]
    out = defaultdict(dict)  # (時刻) → {(var, lead, model): 値}
    d = datetime.fromisoformat(START)
    while d <= datetime.fromisoformat(END):
        e = min(d + timedelta(days=89), datetime.fromisoformat(END))
        q = urllib.parse.urlencode({'latitude': lat, 'longitude': lon, 'hourly': ','.join(hourly), 'models': ','.join(MODELS),
            'start_date': d.date().isoformat(), 'end_date': e.date().isoformat(), 'wind_speed_unit': 'ms', 'timezone': 'GMT'})
        j = json.loads(cached(f'f_{st}_{d.date()}.json', 'https://previous-runs-api.open-meteo.com/v1/forecast?' + q))
        if 'hourly' not in j:
            say('no hourly', st, d.date(), str(j)[:200])
        else:
            H = j['hourly']
            for i, ts in enumerate(H['time']):
                t = datetime.fromisoformat(ts)
                for v in VARS:
                    for l in LEADS:
                        for m in MODELS:
                            x = H.get(f'{v}_previous_day{l}_{m}')
                            if x and x[i] is not None:
                                out[t][(v, l, m)] = x[i]
        d = e + timedelta(days=1); time.sleep(1)
    return out

def season(t):
    return ['DJF', 'DJF', 'MAM', 'MAM', 'MAM', 'JJA', 'JJA', 'JJA', 'SON', 'SON', 'SON', 'DJF'][t.month - 1]

rows = []  # 1行 = 観測点・時刻・変数・リード
for st in STATIONS:
    try:
        O, F = obs(st), fcst(st)
    except Exception as e:
        say('skip', st, e); continue
    n = 0
    for t, fv in F.items():
        if t not in O:
            continue
        for v, ov in VARS.items():
            if ov not in O[t]:
                continue
            for l in LEADS:
                fs = {m: fv.get((v, l, m)) for m in MODELS}
                if sum(x is not None for x in fs.values()) < 2:
                    continue
                rows.append(dict(st=st, t=t, var=v, lead=l, f=fs, y=O[t][ov])); n += 1
    say(st, 'obs', len(O), 'fc', len(F), 'pairs', n)

split = datetime.fromisoformat(SPLIT)
train = [r for r in rows if r['t'] < split]
test = [r for r in rows if r['t'] >= split]
say('train', len(train), 'test', len(test))

def key(r):
    return (r['st'], season(r['t']), r['lead'], r['var'], r['t'].hour // 6)

result = {'period': {'train': [START, SPLIT], 'test': [SPLIT, END]}, 'stations': STATIONS, 'models': MODELS, 'by': {}}
# GBM（sklearn があれば）：各モデルの予報・その差・時刻・季節・リードを特徴量に、実況を直接当てる
try:
    from sklearn.ensemble import HistGradientBoostingRegressor
    import numpy as np
except Exception:
    HistGradientBoostingRegressor = None

for v in VARS:
    for l in LEADS + ['all']:
        tr = [r for r in train if r['var'] == v and (l == 'all' or r['lead'] == l)]
        te = [r for r in test if r['var'] == v and (l == 'all' or r['lead'] == l)]
        if not tr or not te:
            continue
        b = Blender(shrink_n=200).fit(Sample(key(r), r['f'], r['y']) for r in tr)
        ev = evaluate(b, [Sample(key(r), r['f'], r['y']) for r in te])
        if HistGradientBoostingRegressor:
            sts = sorted(STATIONS)
            def X(rs):
                out = []
                for r in rs:
                    f = [r['f'][m] if r['f'][m] is not None else np.nan for m in MODELS]
                    mean = np.nanmean(f)
                    out.append(f + [mean, np.nanstd(f), r['lead'], r['t'].hour, math.sin(2 * math.pi * r['t'].timetuple().tm_yday / 365.25),
                                    math.cos(2 * math.pi * r['t'].timetuple().tm_yday / 365.25), sts.index(r['st'])])
                return np.array(out)
            g = HistGradientBoostingRegressor(max_iter=400, learning_rate=0.05, l2_regularization=1.0, categorical_features=[len(MODELS) + 6], random_state=0)
            g.fit(X(tr), np.array([r['y'] for r in tr]))
            e = g.predict(X(te)) - np.array([r['y'] for r in te])
            ev['skylab_gbm'] = {'rmse': float(np.sqrt(np.mean(e * e))), 'mae': float(np.mean(np.abs(e))), 'n': len(e)}
        result['by'][f'{v}|lead{l}'] = ev
        say(v, l, json.dumps({k: round(x['rmse'], 3) for k, x in ev.items()}))
json.dump(result, open(OUT + '/skill.json', 'w'), indent=1)
