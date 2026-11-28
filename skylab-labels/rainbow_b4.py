"""H-B4：虹の確率に「雨が止んで1時間以内・風速21m/s未満・気温8℃超・雲量40%超」（文献56）を足すと当たるか。
写真（撮影時刻・位置つき）を正例、同じ地点・同じ月の「太陽高度 0〜42° の日中」の別時刻を負例（1枚につき5点）。
モデルA：今の SkyLab の考え方（太陽高度・前後1時間の雨・直達日射）。モデルB：A＋文献56の条件。
撮影地点でまとめた5分割交差検証で Brier・対数損失を比べる（同じ地点が学習と検証に混ざらない）。"""
import csv, json, math, os, random, re, time, urllib.parse, urllib.request
from datetime import datetime, timedelta
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
random.seed(11); os.makedirs('out', exist_ok=True)
exec(open('rainbow_conditions.py').read().split("rows = [r for r")[0].split("random.seed(7)")[1].replace("log = open('out/rainbow_log.txt', 'a')", "log = open('out/b4_log.txt', 'a')"))
rows = [r for r in csv.DictReader(open('results/labels_commons.csv')) if r['phenomenon'] == 'rainbow' and r['lat']]
cases = []
for r in rows:
    t = parse(r['taken_raw'])
    try: lat, lon = float(r['lat']), float(r['lon'])
    except ValueError: continue
    if t and 1990 <= t.year <= 2026 and t < datetime(2026, 11, 20): cases.append((lat, lon, t))
random.shuffle(cases); cases = cases[:int(os.environ.get('MAX', '1200'))]
say('cases', len(cases))
X, y, g = [], [], []
def feats(H, i, lat, lon):
    n = len(H['time']); P = H['precipitation']
    pr = max((P[k] or 0) for k in range(max(0, i - 1), min(n, i + 2)))
    rained = any((P[k] or 0) > 0 for k in range(max(0, i - 1), i + 1))
    ended = rained and (P[min(n - 1, i)] or 0) < 0.2
    dr = H['direct_radiation'][i] or 0
    utc = datetime.fromisoformat(H['time'][i]) - timedelta(seconds=H['_off'])
    alt = sun_alt(lat, lon, utc)
    w = (H['wind_speed_10m'][i] or 0) / 3.6; T = H['temperature_2m'][i]; cc = H['cloud_cover'][i] or 0
    a = [1 if 0 < alt < 42 else 0, (42 - alt) / 42 if 0 < alt < 42 else 0, 1 if pr > 0 else 0, math.log1p(pr), 1 if dr > 0 else 0, math.log1p(dr)]
    b = a + [1 if ended else 0, 1 if w < 21 else 0, 1 if (T is not None and T > 8) else 0, 1 if cc > 40 else 0, cc / 100]
    return alt, a, b
for ci, (lat, lon, t) in enumerate(cases):
    d0 = t.date().replace(day=1); d1 = (d0 + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    q = urllib.parse.urlencode({'latitude': lat, 'longitude': lon, 'start_date': d0, 'end_date': d1,
        'hourly': 'precipitation,direct_radiation,wind_speed_10m,temperature_2m,cloud_cover', 'timezone': 'auto'})
    j = get('https://archive-api.open-meteo.com/v1/archive?' + q); time.sleep(0.4)
    if not j or 'hourly' not in j: continue
    H = j['hourly']; H['_off'] = j.get('utc_offset_seconds', 0)
    key = t.replace(minute=0).isoformat(timespec='minutes')
    if key not in H['time']: continue
    i = H['time'].index(key)
    alt, a, b = feats(H, i, lat, lon)
    X.append((a, b)); y.append(1); g.append(round(lat, 1) * 1000 + round(lon, 1))
    pool = [k for k in range(len(H['time'])) if abs(k - i) > 24 and 0 < feats(H, k, lat, lon)[0] < 42]
    for k in random.sample(pool, min(5, len(pool))):
        X.append(feats(H, k, lat, lon)[1:]); y.append(0); g.append(g[-1])
    if ci % 100 == 0: say('progress', ci, len(y))
y = np.array(y); g = np.array(g)
res = {'n_photos': int(y.sum()), 'n_controls': int((1 - y).sum())}
for name, col in [('A_now', 0), ('B_plus_lit56', 1)]:
    M = np.array([x[col] for x in X], float); p = np.zeros(len(y))
    for tr, te in GroupKFold(5).split(M, y, g):
        p[te] = LogisticRegression(max_iter=2000, C=1.0).fit(M[tr], y[tr]).predict_proba(M[te])[:, 1]
    res[name] = {'brier': round(brier_score_loss(y, p), 4), 'logloss': round(log_loss(y, p), 4), 'auc': round(roc_auc_score(y, p), 4)}
res['climatology_brier'] = round(float(y.mean() * (1 - y.mean())), 4)
M = np.array([x[1] for x in X], float)
res['B_coef'] = dict(zip(['sun_window', 'sun_low', 'rain', 'log_rain', 'sunshine', 'log_direct', 'rain_ended_1h', 'wind_lt21', 'temp_gt8', 'cloud_gt40', 'cloud_frac'],
    [round(c, 3) for c in LogisticRegression(max_iter=2000).fit(M, y).coef_[0]]))
say(json.dumps(res, ensure_ascii=False)); json.dump(res, open('out/b4_result.json', 'w'), indent=1, ensure_ascii=False)
