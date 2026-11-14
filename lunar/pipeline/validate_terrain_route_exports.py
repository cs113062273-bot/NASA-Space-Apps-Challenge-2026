"""Validate real desktop route JSON/CSV against frozen independent graph evidence."""
from pathlib import Path
from datetime import datetime,timezone
import csv,hashlib,json,math
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
    output=ROOT/'app/test-results';packet=output/'terrain-route-native.json';csv_path=output/'terrain-route-native.csv';report=json.loads(packet.read_text(encoding='utf-8'))
    ref=json.loads((ROOT/'app/tests/fixtures/terrain-route.json').read_text(encoding='utf-8'));oracle=next(r for r in ref['native'] if r['id']=='c1' and r['settings']['widthM']==4)
    source=report['source']['patch'];path=ROOT/'app/public/data/landing-terrain'/source['file']
    if source['sha256']!=oracle['patchSha256'] or sha(path)!=source['sha256']:raise ValueError('Route source identity differs')
    if report['result']['status']!='found' or abs(report['result']['cost']-oracle['reference']['cost'])>1e-7:raise ValueError('Browser route differs from independent Dijkstra optimum')
    if any(report['settings'][k]!=v for k,v in oracle['settings'].items()):raise ValueError('Browser route criteria differ from independent reference')
    rows=list(csv.DictReader(line for line in csv_path.read_text(encoding='utf-8').splitlines() if line and not line.startswith('#')))
    nodes=report['result']['nodes'];fields=np.fromfile(path,dtype='<f4').reshape(5,source['rows']*source['cols']);distance=ascent=descent=cost=0.;maximum=stressed_maximum=0.
    if len(rows)!=len(nodes) or nodes[0]['index']!=oracle['start'] or nodes[-1]['index']!=oracle['goal']:raise ValueError('Browser route endpoints/CSV rows differ')
    for i,(row,node) in enumerate(zip(rows,nodes)):
        k=node['index'];x=source['x0']+(k%source['cols'])*source['stepM'];y=source['y0']-(k//source['cols'])*source['stepM'];z=float(fields[3,k]);rms=float(fields[4,k])
        latitude=math.degrees(2*math.atan(math.hypot(x,y)/(2*1737400))-math.pi/2);longitude=math.degrees(math.atan2(x,y))%360
        if abs(node['lat']-latitude)>1e-9 or abs(node['lon']-longitude)>1e-9:raise ValueError('Route geographic coordinates differ from independent lunar inverse projection')
        for key,value in [('step',i),('x_m',x),('y_m',y),('height_m',z),('height_rms_m',rms),('map_distance_m',node['distanceM']),('node_clearance_m',node['nodeClearanceM']),('latitude_deg',node['lat']),('longitude_deg',node['lon'])]:
            if abs(float(row[key])-value)>1e-9:raise ValueError('CSV field differs from source/report: '+key)
        if i:
            before=nodes[i-1];u=before['index'];dr=k//source['cols']-u//source['cols'];dc=k%source['cols']-u%source['cols'];direction=ref['directions'].index([dr,dc])
            if not oracle['reference']['allowedDirections'][u]&(1<<direction):raise ValueError('Route edge is not independently certified')
            length=math.hypot(x-before['x'],y-before['y']);dh=z-before['heightM'];grade=math.degrees(math.atan2(abs(dh),length));stress=math.degrees(math.atan2(abs(dh)+report['settings']['heightRmsMultiplier']*(float(fields[4,u])+rms),length))
            if abs(float(row['nominal_grade_from_previous_deg'])-grade)>1e-9 or abs(float(row['stressed_grade_from_previous_deg'])-stress)>1e-9:raise ValueError('CSV grade differs from independent source calculation')
            maximum=max(maximum,grade);stressed_maximum=max(stressed_maximum,stress);distance+=length;ascent+=max(0,dh);descent+=max(0,-dh);cost+=length+report['settings']['ascentCost']*max(0,dh)
        elif row['nominal_grade_from_previous_deg'] or row['stressed_grade_from_previous_deg']:raise ValueError('First route vertex must have no incoming grade')
    expected={'mapLengthM':distance,'ascentM':ascent,'descentM':descent,'cost':cost,'maxNominalGradeDeg':maximum,'maxStressedGradeDeg':stressed_maximum}
    for key,value in expected.items():
        if abs(report['result'][key]-value)>1e-8:raise ValueError('Route summary differs: '+key)
    artifact={'schema':1,'checkedUTC':datetime.now(timezone.utc).isoformat(),'sourcePatchSha256':source['sha256'],'vertices':len(nodes),'certifiedEdges':len(nodes)-1,'summary':expected,
        'jsonSha256':sha(packet),'csvSha256':sha(csv_path),'referenceSha256':sha(ROOT/'app/tests/fixtures/terrain-route.json'),
        'codeSha256':{p.relative_to(ROOT).as_posix():sha(p) for p in [Path(__file__),ROOT/'app/src/lib/terrain-route.ts',ROOT/'pipeline/build_route_reference.py']},
        'limits':['Same source raster, independent GEOS graph/SciPy Dijkstra and source arithmetic','Static map-plane grid route, not moving-vehicle mission or flight validation']}
    (ROOT/'data/validation/terrain-route-check.json').write_text(json.dumps(artifact,indent=2,allow_nan=False)+'\n',encoding='utf-8',newline='\n');print(f'Validated actual browser JSON/CSV: {len(nodes)} vertices, {len(nodes)-1} independently certified edges and Dijkstra optimum')
if __name__=='__main__':main()
