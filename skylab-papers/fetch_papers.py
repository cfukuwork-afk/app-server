"""全206本の要旨・結論を一括取得（OpenAlex / arXiv / Semantic Scholar / オープンアクセス PDF）。
本文はリポジトリに入れない（Actions の成果物のみ）。"""
import json, re, io, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
UA = {'User-Agent': 'skylab-research (mailto:skylab-bot@users.noreply.github.com)'}
def get(u, t=40, raw=False):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=t) as r:
                b = r.read(); return b if raw else json.loads(b)
        except Exception: time.sleep(2 * (i + 1))
    return None
def inv(ix):
    if not ix: return ''
    w = {}
    for k, ps in ix.items():
        for p in ps: w[p] = k
    return ' '.join(w[i] for i in sorted(w))
def pdftext(u):
    b = get(u, 60, raw=True)
    if not b or not b[:5] == b'%PDF-': return ''
    try:
        from pypdf import PdfReader
        r = PdfReader(io.BytesIO(b)); t = '\n'.join((p.extract_text() or '') for p in r.pages[:40])
    except Exception: return ''
    t = re.sub(r'[ \t]+', ' ', t)
    m = [x.start() for x in re.finditer(r'\n\s*(\d+\.?\s*)?(Conclusions?|Summary and conclusions?|Discussion and conclusions?|Concluding remarks)\b', t, re.I)]
    concl = t[m[-1]:m[-1] + 4000] if m else ''
    res = [x.start() for x in re.finditer(r'\n\s*(\d+\.?\s*)?Results?\b', t)]
    nums = ' '.join(re.findall(r'[^.\n]*\d+(?:\.\d+)?\s?(?:%|km|mm|hPa|dB|°|K)\b[^.\n]*\.', t)[:25])
    return json.dumps({'conclusion': concl, 'numeric_sentences': nums[:4000], 'pages': len(t)}, ensure_ascii=False)
def one(p):
    out = {'no': p['no'], 'title': p['title']}
    w = None
    if p.get('doi'):
        w = get('https://api.openalex.org/works/doi:' + urllib.parse.quote(p['doi']))
    if not w and p.get('title'):
        j = get('https://api.openalex.org/works?per-page=1&search=' + urllib.parse.quote(p['title'][:200]))
        w = (j or {}).get('results', [None])[0] if j and j.get('results') else None
    if w:
        out.update(oa_title=w.get('title'), year=w.get('publication_year'), venue=((w.get('primary_location') or {}).get('source') or {}).get('display_name'),
                   doi=w.get('doi'), cited=w.get('cited_by_count'), abstract=inv(w.get('abstract_inverted_index')))
        pdfs = [l.get('pdf_url') for l in (w.get('locations') or []) if l.get('pdf_url')]
        b = (w.get('best_oa_location') or {}).get('pdf_url')
        if b: pdfs.insert(0, b)
    else: pdfs = []
    d = (p.get('doi') or '')
    if 'arXiv.' in d or 'arxiv' in (p.get('url') or ''):
        aid = d.split('arXiv.')[-1] if 'arXiv.' in d else p['url'].rstrip('/').split('/')[-1]
        pdfs.insert(0, f'https://arxiv.org/pdf/{aid}')
        if not out.get('abstract'):
            x = get(f'http://export.arxiv.org/api/query?id_list={aid}', raw=True)
            if x: out['abstract'] = re.sub(r'\s+', ' ', (re.search(rb'<summary>(.*?)</summary>', x, re.S) or [b'', b''])[1].decode())
    if not out.get('abstract') and p.get('title'):
        c = get('https://api.crossref.org/works?rows=1&query.bibliographic=' + urllib.parse.quote(p['title'][:200] + ' ' + str(p.get('year') or '')))
        it = ((c or {}).get('message') or {}).get('items') or []
        if it and it[0].get('abstract'):
            out['abstract'] = re.sub(r'<[^>]+>', ' ', it[0]['abstract']); out['oa_title'] = (it[0].get('title') or [''])[0]; out['doi'] = it[0].get('DOI')
    if not out.get('abstract') and p.get('title'):
        s = get('https://api.semanticscholar.org/graph/v1/paper/search?limit=1&fields=title,abstract,tldr,year&query=' + urllib.parse.quote(p['title'][:200]))
        if s and s.get('data'): out['abstract'] = s['data'][0].get('abstract') or ((s['data'][0].get('tldr') or {}).get('text'))
    for u in pdfs[:3]:
        t = pdftext(u)
        if t: out['fulltext'] = json.loads(t); out['pdf'] = u; break
    print(p['no'], bool(out.get('abstract')), bool(out.get('fulltext')), flush=True)
    return out
Q = json.load(open('queue.json'))
with ThreadPoolExecutor(8) as ex: R = list(ex.map(one, Q))
json.dump(R, open('out/papers_digest.json', 'w'), ensure_ascii=False)
print('abstract', sum(bool(r.get('abstract')) for r in R), 'fulltext', sum(bool(r.get('fulltext')) for r in R), 'of', len(R))
