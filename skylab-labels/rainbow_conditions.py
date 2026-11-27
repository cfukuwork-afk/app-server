"""仮説 H-B1 の検証：虹の写真（撮影時刻・位置つき）の時刻に、
  (a) 太陽高度 0〜42°、(b) 雨（その時刻の前後1時間に降水）、(c) 日差し（直達日射 > 0）がそろっていたか。
対照：同じ地点・同じ月の、ランダムに選んだ日中の時刻（虹の写真がない時刻）。
気象は Open-Meteo の過去データ（ERA5 系の再解析）。※これは「虹が出る条件」の研究用で、予報の特徴量には使わない
"""
import csv, json, math, os, random, re, time, urllib.parse, urllib.request
from datetime import datetime, timedelta
random.seed(7)
os.makedirs('out', exist_ok=True)
log = open('out/rainbow_log.txt', 'a')
def say(*a):
    print(*a, flush=True); print(*a, file=log, flush=True)
def get(url):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'SkyLab research'}), timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:
            say('retry', i, e); time.sleep(5 * (i + 1))
    return None
rad = math.pi / 180
def sun_alt(lat, lon, t_utc):
    n = (t_utc - datetime(2000, 1, 1, 12)).total_seconds() / 86400
    L = (280.46 + 0.9856474 * n) % 360; g = ((357.528 + 0.9856003 * n) % 360) * rad
    lam = (L + 1.915 * math.sin(g) + 0.02 * math.sin(2 * g)) * rad; eps = (23.439 - 4e-7 * n) * rad
    ra = math.atan2(math.cos(eps) * math.sin(lam), math.cos(lam)); dec = math.asin(math.sin(eps) * math.sin(lam))
    gmst = (18.697374558 + 24.06570982441908 * n) % 24
    ha = (gmst * 15 + lon) * rad - ra
    return math.asin(math.sin(lat * rad) * math.sin(dec) + math.cos(lat * rad) * math.cos(dec) * math.cos(ha)) / rad
def parse(s):
    m = re.match(r'(\d{4})[:\-](\d\d)[:\-](\d\d)[ T](\d\d):(\d\d)', s or '')
    return datetime(*map(int, m.groups())) if m else None

rows = [r for r in csv.DictReader(open('results/labels_commons.csv')) if r['phenomenon'] == 'rainbow' and r['lat']]
cases = []
for r in rows:
    t = parse(r['taken_raw'])
    try:
        lat, lon = float(r['lat']), float(r['lon'])
    except ValueError:
        continue
    if t and 1990 <= t.year <= 2026 and t < datetime(2026, 11, 20):
        cases.append((lat, lon, t, r['file']))
say('usable', len(cases))
MAX = int(os.environ.get('MAX', '1000'))
def cond(lat, lon, local, H, idx):
    # idx: その時刻の行。前後1時間の降水、その時刻の直達日射
    pr = max((H['precipitation'][k] or 0) for k in range(max(0, idx - 1), min(len(H['time']), idx + 2)))
    dr = H['direct_radiation'][idx] or 0
    low = H['cloud_cover_low'][idx]
    utc = local - timedelta(seconds=H['_off'])
    alt = sun_alt(lat, lon, utc)
    return {'alt': alt, 'pr': pr, 'dr': dr, 'low': low, 'A': 0 < alt < 42, 'B': pr > 0, 'C': dr > 0}
res = {'photo': [], 'control': []}
for lat, lon, t, f in cases[:MAX]:
    d0 = t.date().replace(day=1)
    d1 = (d0 + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    q = urllib.parse.urlencode({'latitude': lat, 'longitude': lon, 'start_date': d0, 'end_date': d1, 'hourly': 'precipitation,direct_radiation,cloud_cover_low', 'timezone': 'auto'})
    j = get('https://archive-api.open-meteo.com/v1/archive?' + q)
    time.sleep(0.4)
    if not j or 'hourly' not in j:
        continue
    H = j['hourly']; H['_off'] = j.get('utc_offset_seconds', 0)
    times = [datetime.fromisoformat(x) for x in H['time']]
    key = t.replace(minute=0, second=0) + (timedelta(hours=1) if t.minute >= 30 else timedelta())
    if key not in times:
        continue
    i = times.index(key)
    res['photo'].append(cond(lat, lon, key, H, i))
    # 対照：同じ月の日中（太陽高度 > 0）の時刻から 5 つ
    day_idx = [k for k, x in enumerate(times) if abs((x - key).total_seconds()) > 86400 and sun_alt(lat, lon, x - timedelta(seconds=H['_off'])) > 0]
    for k in random.sample(day_idx, min(5, len(day_idx))):
        res['control'].append(cond(lat, lon, times[k], H, k))
    if len(res['photo']) % 50 == 0:
        say('done', len(res['photo']))
def summ(L):
    n = len(L)
    f = lambda key: round(sum(1 for x in L if key(x)) / max(1, n), 4)
    return {'n': n, 'A_sun_0_42': f(lambda x: x['A']), 'B_rain_pm1h': f(lambda x: x['B']), 'C_direct_sun': f(lambda x: x['C']),
            'ABC_all': f(lambda x: x['A'] and x['B'] and x['C']), 'A_and_B': f(lambda x: x['A'] and x['B']),
            'sun_alt_median': sorted(x['alt'] for x in L)[n // 2] if n else None}
out = {'hypothesis': 'H-B1', 'photo': summ(res['photo']), 'control': summ(res['control'])}
p, c = out['photo']['ABC_all'], out['control']['ABC_all']
out['lift_ABC'] = round(p / c, 2) if c else None
json.dump(out, open('out/rainbow_conditions.json', 'w'), indent=1)
json.dump(res, open('out/rainbow_conditions_raw.json', 'w'))
say(json.dumps(out))
