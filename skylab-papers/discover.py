"""206本の外の論文を探す：OpenAlex で現象ごとに検索、要旨つき・新しめ・引用の多いものを集める。"""
import json, time, urllib.parse, urllib.request, re
UA={'User-Agent':'skylab-research (mailto:skylab-bot@users.noreply.github.com)'}
def get(u):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=40) as r: return json.loads(r.read())
        except Exception: time.sleep(3*(i+1))
def inv(ix):
    w={}
    for k,ps in (ix or {}).items():
        for p in ps: w[p]=k
    return ' '.join(w[i] for i in sorted(w))
known=set(json.load(open('known_dois.json'))); seen=set(); out=[]
for q in json.load(open('discover_queries.json')):
    for sort in ['relevance_score:desc','cited_by_count:desc']:
        j=get('https://api.openalex.org/works?per-page=25&sort=%s&filter=has_abstract:true,publication_year:>1979&search=%s'%(sort,urllib.parse.quote(q)))
        for w in (j or {}).get('results',[]):
            d=(w.get('doi') or '').replace('https://doi.org/','').lower()
            if not d or d in known or d in seen: continue
            seen.add(d)
            out.append({'q':q,'doi':d,'title':w.get('title'),'year':w.get('publication_year'),'cited':w.get('cited_by_count'),
                        'venue':((w.get('primary_location') or {}).get('source') or {}).get('display_name'),
                        'oa':(w.get('best_oa_location') or {}).get('pdf_url'),'abstract':inv(w.get('abstract_inverted_index'))})
    print(q,len(out),flush=True)
json.dump(out,open('out/discover.json','w'),ensure_ascii=False)
