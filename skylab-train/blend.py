"""複数の気象モデルの動的な重み付け（地域・季節・予報時間ごと）。

考え方：過去の「予報 − 実況」の誤差から、条件（地域・季節・リードタイムの区分）ごとに各モデルの平均二乗誤差を出し、
誤差の小さいモデルほど重くする（逆MSE重み）。件数が少ない区分は、全体の値に寄せる（縮小推定）。
さらに、区分ごとの平均のずれ（バイアス）を引いてから混ぜる。

- 学習に使う過去データは、予測を出す時点より前のものだけ（fit に渡す前に呼び出し側で切る。test でも確認）
- 重みが改善しているかは、必ず学習に使っていない期間で、単一モデル・単純平均と比べて確かめる（evaluate）
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, Hashable, Iterable, List, Optional, Tuple


@dataclass
class Sample:
    key: Hashable                 # 例 ('cambridge', 'DJF', '0-24h', 'temperature_2m')
    forecasts: Dict[str, float]   # モデル名 → 予報値
    observed: float


@dataclass
class Blender:
    shrink_n: float = 30.0                      # この件数ほどで、区分の値と全体の値が半々になる
    stats: Dict[Hashable, Dict[str, Tuple[float, float, int]]] = field(default_factory=dict)  # key → model → (bias和, 二乗誤差和, 件数)
    total: Dict[str, Tuple[float, float, int]] = field(default_factory=dict)

    def fit(self, samples: Iterable[Sample]) -> 'Blender':
        st: Dict[Hashable, Dict[str, List[float]]] = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0]))
        tot: Dict[str, List[float]] = defaultdict(lambda: [0.0, 0.0, 0])
        for s in samples:
            for m, f in s.forecasts.items():
                if f is None:
                    continue
                e = f - s.observed
                for acc in (st[s.key][m], tot[m]):
                    acc[0] += e
                    acc[1] += e * e
                    acc[2] += 1
        self.stats = {k: {m: tuple(v) for m, v in d.items()} for k, d in st.items()}
        self.total = {m: tuple(v) for m, v in tot.items()}
        return self

    def _bias_mse(self, key: Hashable, m: str) -> Optional[Tuple[float, float]]:
        if m not in self.total or self.total[m][2] == 0:
            return None
        tb, ts, tn = self.total[m]
        gb, gm = tb / tn, ts / tn
        b, s, n = self.stats.get(key, {}).get(m, (0.0, 0.0, 0))
        if n == 0:
            return gb, gm
        a = n / (n + self.shrink_n)  # 縮小推定：件数が少ないほど全体の値に寄せる
        return a * (b / n) + (1 - a) * gb, a * (s / n) + (1 - a) * gm

    def weights(self, key: Hashable, models: Iterable[str]) -> Dict[str, float]:
        inv = {}
        for m in models:
            bm = self._bias_mse(key, m)
            if bm is None:
                continue
            bias, mse = bm
            var = max(mse - bias * bias, 1e-9)  # バイアスを引いた後の誤差の大きさで重みを決める
            inv[m] = 1.0 / var
        z = sum(inv.values())
        return {m: v / z for m, v in inv.items()} if z else {}

    def predict(self, key: Hashable, forecasts: Dict[str, float]) -> Optional[float]:
        avail = {m: f for m, f in forecasts.items() if f is not None}
        w = self.weights(key, avail)
        if not w:
            return None
        return sum(w[m] * (avail[m] - self._bias_mse(key, m)[0]) for m in w)


def evaluate(blender: Blender, test: List[Sample]) -> dict:
    """学習に使っていないデータで、各単一モデル・単純平均・重み付けの誤差（RMSE・MAE）を比べる"""
    import math
    models = sorted({m for s in test for m in s.forecasts})
    errs: Dict[str, List[float]] = defaultdict(list)
    for s in test:
        for m in models:
            if s.forecasts.get(m) is not None:
                errs[m].append(s.forecasts[m] - s.observed)
        vals = [v for v in s.forecasts.values() if v is not None]
        if vals:
            errs['mean_of_models'].append(sum(vals) / len(vals) - s.observed)
        p = blender.predict(s.key, s.forecasts)
        if p is not None:
            errs['skylab_blend'].append(p - s.observed)
    return {k: {'rmse': math.sqrt(sum(e * e for e in v) / len(v)), 'mae': sum(abs(e) for e in v) / len(v), 'n': len(v)} for k, v in errs.items() if v}
