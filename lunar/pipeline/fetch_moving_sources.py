"""Pin newly inspected primary motion/design research; never execute remote code."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json
import httpx

ROOT=Path(__file__).resolve().parents[1];CACHE=ROOT/'data/raw/research';MANIFEST=ROOT/'data/validation/moving-route-sources.json'
SOURCES={
    'lamarre-2025-full.html':'https://arxiv.org/html/2401.08558v2',
    'roverdevkit-2026-v2.html':'https://arxiv.org/html/2606.21755v2',
    'roverdevkit-repository.html':'https://github.com/Complex-Systems-Engineering-Lab/roverdevkit',
    'tompkins-2004-mission.pdf':'https://publications.ri.cmu.edu/storage/publications/pub_files/pub4/tompkins_paul_2004_1/tompkins_paul_2004_1.pdf',
    'hybrid-rover-energy-2025.html':'https://arxiv.org/html/2509.15062',
}
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
    CACHE.mkdir(parents=True,exist_ok=True);manifest=json.loads(MANIFEST.read_text(encoding='utf-8')) if MANIFEST.exists() else {'schema':1,'sources':{},'unavailable':{}}
    blocked=set()
    for failure in manifest['unavailable'].values():
        if failure.get('status')==429 and (datetime.now(timezone.utc)-datetime.fromisoformat(failure['recordedUTC'])).total_seconds()<600:blocked.add(httpx.URL(failure['url']).host)
    with httpx.Client(timeout=25,follow_redirects=True) as client:
        for name,url in SOURCES.items():
            path=CACHE/name;prior=manifest['sources'].get(name)
            if prior:
                if prior['url']!=url or sha(path)!=prior['sha256'] or path.stat().st_size!=prior['bytes']:raise ValueError('Pinned motion research source changed: '+name)
                continue
            if httpx.URL(url).host in blocked:continue
            try:
                response=client.get(url);response.raise_for_status();body=response.content
                if len(body)>20*1024*1024 or name.endswith('.pdf') and not body.startswith(b'%PDF'):raise ValueError('Unexpected research body')
                path.write_bytes(body);manifest['sources'][name]={'url':url,'finalURL':str(response.url),'bytes':len(body),'sha256':sha(path),'retainedUTC':datetime.now(timezone.utc).isoformat()};manifest['unavailable'].pop(name,None)
                print(f'Pinned {name}: {len(body)} bytes',flush=True)
            except (httpx.HTTPError,ValueError) as e:
                status=e.response.status_code if isinstance(e,httpx.HTTPStatusError) else None
                manifest['unavailable'][name]={'url':url,'status':status,'recordedUTC':datetime.now(timezone.utc).isoformat(),'reason':str(e)}
                if status==429:blocked.add(httpx.URL(url).host)
                print(f'Unavailable {name}: {status}; no raw-byte provenance claimed',flush=True)
            manifest['scope']='Primary publisher research and repository documentation; no remote code executed, no competitor UI task, timing or hardware validation. Retained repository request/final redirect URLs are recorded per source.'
            MANIFEST.write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8',newline='\n')
if __name__=='__main__':main()
