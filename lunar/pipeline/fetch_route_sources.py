"""Retain the specific primary route/competitor documents inspected in this phase.

No remote code is executed. Existing source files are verified, not replaced.
"""
from pathlib import Path
from datetime import datetime,timezone
import json,hashlib
import httpx
from urllib.parse import urlparse
ROOT=Path(__file__).resolve().parents[1]
CACHE=ROOT/'data/raw/research';MANIFEST=ROOT/'data/validation/terrain-route-sources.json'
SOURCES={
    'navlunar-home.html':'https://navlunar.com/',
    'navlunar-about.html':'https://navlunar.com/about',
    'otten-2015-routes.pdf':'https://publications.ri.cmu.edu/storage/publications/2018/01/ICRA2015_Otten_3109.pdf',
    'lamarre-route-abstract.html':'https://arxiv.org/abs/2401.08558',
}
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
    CACHE.mkdir(parents=True,exist_ok=True);prior=json.loads(MANIFEST.read_text(encoding='utf-8')) if MANIFEST.exists() else {'schema':1,'sources':{}}
    blocked=set()
    for failure in prior.get('unavailable',{}).values():
        if failure.get('status')==429 and (datetime.now(timezone.utc)-datetime.fromisoformat(failure['recordedUTC'])).total_seconds()<600:blocked.add(urlparse(failure['url']).hostname)
    for name,url in SOURCES.items():
        path=CACHE/name;entry=prior['sources'].get(name)
        if entry:
            if entry['url']!=url or path.stat().st_size!=entry['bytes'] or sha(path)!=entry['sha256']:raise ValueError('Pinned research source differs: '+name)
            continue
        host=urlparse(url).hostname
        if host in blocked:
            print(f'Skipped {name}: host was rate-limited; no raw-byte provenance claimed',flush=True);continue
        try:response=httpx.get(url,timeout=60,follow_redirects=True);response.raise_for_status()
        except httpx.HTTPError as error:
            status=error.response.status_code if isinstance(error,httpx.HTTPStatusError) else None
            prior.setdefault('unavailable',{})[name]={'url':url,'status':status,'recordedUTC':datetime.now(timezone.utc).isoformat(),'reason':str(error)}
            if status==429:blocked.add(host)
            print(f'Unavailable {name}: {status}; no raw-byte provenance claimed',flush=True);continue
        if len(response.content)>20*1024*1024 or name.endswith('.pdf') and not response.content.startswith(b'%PDF'):raise ValueError('Unexpected research source body')
        path.write_bytes(response.content);prior['sources'][name]={'url':url,'finalURL':str(response.url),'bytes':path.stat().st_size,'sha256':sha(path),'retainedUTC':datetime.now(timezone.utc).isoformat()}
        print(f'Pinned {name}: {path.stat().st_size:,} bytes',flush=True)
        prior.setdefault('unavailable',{}).pop(name,None)
    prior['scope']='Publisher descriptions and research methodology, not an executed competitor task, measured vehicle model or superiority result. Homepage/about descriptions of NavLunar route shadows differ; no missing/present runtime feature inferred.'
    MANIFEST.write_text(json.dumps(prior,indent=2,allow_nan=False)+'\n',encoding='utf-8',newline='\n')
if __name__=='__main__':main()
