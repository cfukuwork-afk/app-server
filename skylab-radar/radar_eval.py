"""英国 Met Office レーダー合成（1 km・15 分）で、雨のナウキャストを過去の事例で検証する
手法：Eulerian 持続（今の雨がそのまま）／pysteps の光学流（Lucas-Kanade）＋セミラグランジュ外挿
評価：リード 15〜120 分ごとの CSI（0.5・1・5 mm/h）、MAE。結果は out/radar_eval.json
仮説 H-R1：光学流による外挿は、全リードで持続予報より CSI が高い（文献 17・19 の報告の英国での再現）
"""
import boto3, h5py, io, json, os, random, time, datetime as dt
import numpy as np
from botocore import UNSIGNED
from botocore.config import Config
from pysteps import motion, nowcasts
s3 = boto3.client('s3', region_name='eu-west-2', config=Config(signature_version=UNSIGNED))
B = 'met-office-radar-obs-data'
os.makedirs('out', exist_ok=True)
log = open('out/radar_log.txt', 'a')
def say(*a):
    print(*a, flush=True); print(*a, file=log, flush=True)

def load(t):
    key = f"radar/{t:%Y/%m/%d}/{t:%Y%m%d%H%M}_ODIM_ng_radar_rainrate_composite_1km_UK.h5"
    b = s3.get_object(Bucket=B, Key=key)['Body'].read()
    with h5py.File(io.BytesIO(b), 'r') as f:
        ds = f['dataset1']
        d = ds['data1']['data'][()].astype('float32')
        w = dict(ds['data1']['what'].attrs) if 'what' in ds['data1'] else dict(ds['what'].attrs)
        gain, off = float(w.get('gain', 1)), float(w.get('offset', 0))
        nod, und = w.get('nodata'), w.get('undetect')
        x = d * gain + off
        if nod is not None: x[d == nod] = np.nan
        if und is not None: x[d == und] = 0
    return x

N_DAYS = int(os.environ.get('N_DAYS', '40'))
LEADS = [1, 2, 4, 6, 8]  # 15 分単位：15, 30, 60, 90, 120 分
TH = [0.5, 1.0, 5.0]
random.seed(1)
today = dt.datetime.utcnow().replace(minute=0, second=0, microsecond=0)
days = sorted(random.sample(range(10, 700), N_DAYS))
acc = {m: {l: {'hits': {t: 0 for t in TH}, 'miss': {t: 0 for t in TH}, 'fa': {t: 0 for t in TH}, 'ae': 0.0, 'n': 0} for l in LEADS} for m in ['persistence', 'lk_extrap']}
cases = 0
for dd in days:
    for hh in (3, 11, 17):
        t0 = (today - dt.timedelta(days=dd)).replace(hour=hh)
        try:
            past = [load(t0 - dt.timedelta(minutes=15 * k)) for k in (3, 2, 1, 0)]
        except Exception as e:
            say('skip', t0, e); continue
        last = past[-1]
        wet = np.nanmean(last > 0.5)
        if not np.isfinite(wet) or wet < 0.02:  # 雨がほとんど無い場面は除く（評価が意味を持たない）
            continue
        R = np.stack(past)
        R0 = np.nan_to_num(R, nan=0.0)
        V = motion.get_method('LK')(np.log10(np.maximum(R0, 0.01)))
        ext = nowcasts.get_method('extrapolation')(R0[-1], V, max(LEADS))
        for l in LEADS:
            try:
                obs = load(t0 + dt.timedelta(minutes=15 * l))
            except Exception:
                continue
            ok = np.isfinite(obs)
            for m, fc in (('persistence', R0[-1]), ('lk_extrap', np.nan_to_num(ext[l - 1], nan=0.0))):
                a = acc[m][l]
                for t in TH:
                    f, o = (fc >= t) & ok, (obs >= t) & ok
                    a['hits'][t] += int((f & o).sum()); a['miss'][t] += int((~f & o).sum()); a['fa'][t] += int((f & ~o).sum())
                a['ae'] += float(np.abs(fc[ok] - obs[ok]).sum()); a['n'] += int(ok.sum())
        cases += 1
        say('case', t0, 'wet', round(float(wet), 3), 'cases', cases)
res = {'cases': cases, 'thresholds_mm_h': TH, 'leads_min': [15 * l for l in LEADS], 'by_method': {}}
for m, L in acc.items():
    res['by_method'][m] = {str(15 * l): {'csi': {str(t): round(v['hits'][t] / max(1, v['hits'][t] + v['miss'][t] + v['fa'][t]), 4) for t in TH}, 'mae': round(v['ae'] / max(1, v['n']), 4)} for l, v in L.items()}
json.dump(res, open('out/radar_eval.json', 'w'), indent=1)
say(json.dumps(res))
