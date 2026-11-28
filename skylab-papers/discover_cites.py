"""中心となる論文を引用している新しめの論文を集める（関連性が高い）。"""
import json, time, urllib.parse, urllib.request
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
SEEDS=json.load(open('seeds.json')); known=set(json.load(open('known_dois.json'))); seen=set(); out=[]
for name,doi in SEEDS.items():
    w=get('https://api.openalex.org/works/doi:'+doi)
    if not w: print('miss',name); continue
    wid=w['id'].split('/')[-1]
    for sort in ['cited_by_count:desc','publication_date:desc']:
        j=get(f'https://api.openalex.org/works?per-page=25&sort={sort}&filter=cites:{wid},has_abstract:true')
        for x in (j or {}).get('results',[]):
            d=(x.get('doi') or '').replace('https://doi.org/','').lower()
            if not d or d in known or d in seen: continue
            seen.add(d)
            out.append({'q':name,'doi':d,'title':x.get('title'),'year':x.get('publication_year'),'cited':x.get('cited_by_count'),
                        'venue':((x.get('primary_location') or {}).get('source') or {}).get('display_name'),'abstract':inv(x.get('abstract_inverted_index'))})
    print(name,len(out),flush=True)
json.dump(out,open('out/papers_digest.json','w'),ensure_ascii=False)
