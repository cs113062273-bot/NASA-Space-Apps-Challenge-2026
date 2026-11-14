"""Survey official 5 m TIFF footprints using metadata ranges, not whole rasters.

Coverage discovery is not a terrain-quality or frame-registration validation.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
from html.parser import HTMLParser
import hashlib
import json
import math
import struct
from urllib.parse import urljoin

import httpx
import numpy as np

import fetch_site_terrain as source

PAGE='https://pgda.gsfc.nasa.gov/products/78'


def survey(url):
    with httpx.Client(timeout=60,follow_redirects=True) as client:
        def read(offset,size):
            with client.stream('GET',url,headers={'Range':f'bytes={offset}-{offset+size-1}'}) as r:
                if r.status_code!=206 or not r.headers.get('content-range','').startswith(f'bytes {offset}-'):raise ValueError('Official metadata range unavailable')
                data=b''.join(r.iter_bytes())
                if len(data)>size:raise ValueError('Metadata server ignored range size')
                return data
        header=read(0,16)
        if header[:4]!=b'II*\0':raise ValueError('Survey supports little-endian classic TIFF only')
        start=struct.unpack_from('<I',header,4)[0];block=read(start,131072)
        count=struct.unpack_from('<H',block)[0]
        records={}
        for i in range(count):
            key,typ,n,payload=struct.unpack_from('<HHI4s',block,2+12*i);records[key]=(typ,n,payload)
        def tag(key):
            typ,n,payload=records[key];dtype={3:'<u2',4:'<u4',12:'<f8'}[typ];size=n*np.dtype(dtype).itemsize
            if size<=4:data=payload[:size]
            else:
                offset=struct.unpack('<I',payload)[0]
                data=block[offset-start:offset-start+size] if start<=offset and offset+size<=start+len(block) else read(offset,size)
            return np.frombuffer(data,dtype=dtype,count=n)
        width,height=int(tag(256)[0]),int(tag(257)[0]);scale,tie=tag(33550),tag(33922)
        if tuple(scale[:2])!=(5.,5.):raise ValueError('Expected native 5 m grid')
        keys=tag(34735).reshape(-1,4)
        if not any(int(k)==1025 and int(v)==1 for k,_,_,v in keys[1:]):raise ValueError('Expected pixel-area registration')
        left=float(tie[3]-tie[0]*5);top=float(tie[4]+tie[1]*5)
        return {'region':url.split('/')[-2],'url':url,'width':width,'height':height,'bounds':[left,top-height*5,left+width*5,top],
            'header_sha256':hashlib.sha256(header).hexdigest(),'ifd_block_sha256':hashlib.sha256(block).hexdigest(),'metadata_bytes':len(header)+len(block)}


def main():
    class Links(HTMLParser):
        urls=set()
        def handle_starttag(self,tag,attrs):
            href=dict(attrs).get('href','')
            if tag=='a' and href.endswith('_5mpp_surf.tif') and '/Clones/' not in href:
                url=urljoin(PAGE,href)
                if url.startswith(source.BASE+'/'):self.urls.add(url)
    response=httpx.get(PAGE,timeout=60);response.raise_for_status();parser=Links();parser.feed(response.text)
    def safe(url):
        try:return survey(url)
        except Exception as e:return {'url':url,'error':str(e)}
    with ThreadPoolExecutor(3) as pool:regions=list(pool.map(safe,sorted(parser.urls)))
    catalogue=json.loads((source.ROOT/'app/public/data/sites.json').read_text(encoding='utf-8'))['sites']
    retained=set(json.loads(source.MANIFEST.read_text(encoding='utf-8'))['regions'])
    coverage={};needed=set()
    for site in catalogue:
        rho=2*1737400*math.tan(math.radians((90+site['lat'])/2));lo=math.radians(site['lon']);x,y=rho*math.sin(lo),rho*math.cos(lo)
        matches=[]
        for region in regions:
            if 'error' in region:continue
            left,bottom,right,top=region['bounds']
            if left<=x<right and bottom<y<=top:matches.append((min(x-left,right-x,y-bottom,top-y),region['region']))
        coverage[site['id']]=[name for _,name in sorted(matches,reverse=True)]
        if matches and not any(name in retained for _,name in matches):needed.add(max(matches)[1])
    report={'schema':1,'checkedUTC':datetime.now(timezone.utc).isoformat(),'page':PAGE,'page_sha256':hashlib.sha256(response.content).hexdigest(),
        'regions':regions,'curatedCoverage':coverage,'noSurveyedSource':[k for k,v in coverage.items() if not v],
        'additional_regions_for_uncovered_points':sorted(needed),'retained_regions_at_survey':sorted(retained),
        'limits':['TIFF metadata footprints only, not full pixel values or all companion-field validity',
            'Official documentation supplies nominal ME421 frame; no metre-level registration or flight suitability follows']}
    (source.ROOT/'data/validation/terrain-source-inventory.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8',newline='\n')
    print(f'Surveyed {len(regions)} official 5 m region footprints; errors {sum("error" in r for r in regions)}; additional sources for currently uncovered points: {sorted(needed)}',flush=True)


if __name__=='__main__':main()
