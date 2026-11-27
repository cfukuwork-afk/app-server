"""Wikimedia Commons から「現象が写った写真」の撮影時刻・位置・ライセンスを集める（画像本体は保存しない）。
出力 out/labels_commons.csv: phenomenon, file, taken_raw(写真に記録された撮影時刻・現地時刻), lat, lon, gps_source, license, artist_present, category
"""
import csv, json, os, re, time, urllib.parse, urllib.request
API = 'https://commons.wikimedia.org/w/api.php'
UA = {'User-Agent': 'SkyLab-research/0.1 (atmospheric optics forecast verification; github.com/cfukuwork-afk/app-server)'}
ROOTS = {
  'rainbow': ['Category:Rainbows'],
  'sunset': ['Category:Sunsets in the United Kingdom', 'Category:Sunsets in England', 'Category:Sunsets in Scotland', 'Category:Sunsets in Wales'],
  'sunrise': ['Category:Sunrises in the United Kingdom', 'Category:Sunrises in England', 'Category:Sunrises in Scotland'],
  'aurora': ['Category:Aurora borealis in the United Kingdom', 'Category:Aurorae in the United Kingdom', 'Category:Aurora borealis in Scotland', 'Category:Aurora borealis in England'],
  'halo': ['Category:22° halos', 'Category:Sun dogs', 'Category:Halos (optical phenomenon)'],
}
MAXDEPTH = int(os.environ.get('DEPTH', '2'))
MAXCATS = int(os.environ.get('MAXCATS', '400'))  # 1現象あたりのカテゴリ数の上限（前回は全部たどって時間切れ）
T0 = time.time()
os.makedirs('out', exist_ok=True)
log = open('out/log.txt', 'a')
def say(*a):
    print(*a); print(*a, file=log); log.flush()

def api(**p):
    p.update(format='json', formatversion='2')
    for i in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(API + '?' + urllib.parse.urlencode(p), headers=UA), timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:
            say('retry', i, e); time.sleep(5 * (i + 1))
    return {}

def members(cat, kind):
    cont = {}
    while True:
        j = api(action='query', list='categorymembers', cmtitle=cat, cmtype=kind, cmlimit='500', **cont)
        for m in j.get('query', {}).get('categorymembers', []):
            yield m['title']
        if 'continue' not in j:
            return
        cont = {'cmcontinue': j['continue']['cmcontinue']}
        time.sleep(0.2)

def strip(html):
    return re.sub('<[^>]+>', '', html or '').strip()

def details(titles):
    j = api(action='query', titles='|'.join(titles), prop='imageinfo|coordinates', iiprop='extmetadata',
            iiextmetadatafilter='DateTimeOriginal|DateTime|GPSLatitude|GPSLongitude|LicenseShortName|Artist', colimit='max')
    for p in j.get('query', {}).get('pages', []):
        md = ((p.get('imageinfo') or [{}])[0]).get('extmetadata', {})
        g = lambda k: strip(md.get(k, {}).get('value'))
        lat, lon, src = g('GPSLatitude'), g('GPSLongitude'), 'exif'
        if not lat and p.get('coordinates'):
            c = p['coordinates'][0]; lat, lon, src = c['lat'], c['lon'], 'page'
        yield dict(file=p['title'], taken_raw=g('DateTimeOriginal'), lat=lat, lon=lon, gps_source=src if lat else '',
                   license=g('LicenseShortName'), artist_present=bool(g('Artist')))

seen_files, rows = set(), []
for ph, roots in ROOTS.items():
    seen_cats, queue, files = set(), [(r, 0) for r in roots], []
    while queue and len(seen_cats) < MAXCATS:
        cat, d = queue.pop(0)
        if cat in seen_cats:
            continue
        seen_cats.add(cat)
        fs = list(members(cat, 'file'))
        if d == 0 and not fs and not list(members(cat, 'subcat')):
            say('empty or missing root', cat)
        files += [(f, cat) for f in fs if f not in seen_files]
        seen_files.update(fs)
        if d < MAXDEPTH:
            queue += [(c, d + 1) for c in members(cat, 'subcat')]
    say(ph, 'categories', len(seen_cats), 'files', len(files))
    catof = dict(files)
    names = list(catof)
    for i in range(0, len(names), 50):
        for r in details(names[i:i + 50]):
            r.update(phenomenon=ph, category=catof.get(r['file'], ''))
            rows.append(r)
        time.sleep(0.3)
cols = ['phenomenon', 'file', 'taken_raw', 'lat', 'lon', 'gps_source', 'license', 'artist_present', 'category']
with open('out/labels_commons.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, cols); w.writeheader(); w.writerows(rows)
use = [r for r in rows if r['lat'] and re.match(r'\d{4}-\d\d-\d\d \d\d:\d\d', r['taken_raw'] or '')]
say('total', len(rows), 'with time+position', len(use))
for ph in ROOTS:
    say(ph, sum(r['phenomenon'] == ph for r in use))
