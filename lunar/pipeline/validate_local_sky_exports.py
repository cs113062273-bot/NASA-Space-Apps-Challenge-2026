"""Check actual desktop mixed-skyline exports against independent 3D/SciPy rays."""
from pathlib import Path
from datetime import datetime,timezone
import csv,hashlib,json,math

ROOT=Path(__file__).resolve().parents[1]
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def read(path):return json.loads(Path(path).read_text(encoding='utf-8'))

def main():
    output=ROOT/'app/test-results';refpath=ROOT/'app/tests/fixtures/local-sky.json';ref=read(refpath)
    for name,value in ref['sources'].items():
        if sha(ROOT/name)!=value:raise ValueError('Independent reference source changed: '+name)
    checked=[]
    for suffix,refname in [('native','native-c1'),('imported','imported-height-c1')]:
        packet=output/f'mixed-sky-{suffix}.json';p=read(packet);e=p['evidence'];expected=next(v for v in ref['actual'] if v['name']==refname);r=expected['reference']
        if p['point']!={'lat':expected['lat'],'lon':expected['lon']}:raise ValueError('Observer coordinates differ')
        if p['horizons']!=r['horizons']:raise ValueError('Skyline differs from independent 3D ray geometry')
        for key in ['bins','localSamples','nearSamples','farSamples','globeSamples','missingSamples','localGapFallbacks']:
            if e[key]!=r[key]:raise ValueError('Source sample count differs: '+key)
        for key in ['groundM','baselineGroundM','heightRmsM','localDeltaMinM','localDeltaMaxM']:
            if r[key] is None:
                if e[key] is not None:raise ValueError('Unknown value was fabricated: '+key)
            elif not math.isfinite(e[key]) or abs(e[key]-r[key])>1e-5:raise ValueError('Source interpolated height differs: '+key)
        if e['config']['patchSha256']!=e['patchSha256'] or e['source']['meta']['sha256']!=e['patchSha256']:raise ValueError('Local source identity mismatch')
        if len(e['config']['resultSha256'])!=64:raise ValueError('Missing result identity')
        if suffix=='native' and e['patchSha256']!=expected['patchSha256']:raise ValueError('Native patch differs')
        if suffix=='imported':
            if e['source']['meta']['sourceWindow']!=expected['sourceWindow']:raise ValueError('GDAL and browser source windows differ')
            source=ROOT/'app/tests/fixtures/terrain-import/height-area.tif'
            if sha(source)!=e['source']['imported']['files']['height']['sha256']:raise ValueError('Imported source file differs')
        restored=output/f'mixed-sky-{suffix}-restored.json'
        if read(restored)!=p:raise ValueError('Restoration changed the exported source/result')
        checked.append({'name':refname,'sha256':sha(packet),'restoredSha256':sha(restored),'horizonValues':sum(map(len,p['horizons'].values())),'groundM':p['groundM'],'groundDifferenceM':e['groundDifferenceM'],'localGapFallbacks':e['localGapFallbacks'],'missingSamples':e['missingSamples'],'resultSha256':e['config']['resultSha256']})
    def rows(path):
        return list(csv.DictReader(line for line in path.read_text(encoding='utf-8').splitlines() if line and not line.startswith('#')))
    baseline=rows(output/'mixed-sky-baseline.csv');changed=rows(output/'mixed-sky-imported-hourly.csv')
    if len(baseline)!=168 or len(changed)!=168:raise ValueError('Hourly mission extent differs')
    changes={key:sum(a[key]!=b[key] for a,b in zip(baseline,changed)) for key in baseline[0]}
    if not changes['sun_disk_visible_fraction'] or not changes['earth_in_view']:raise ValueError('Imported skyline did not reach Sun/Earth mission calculations')
    text=(output/'mixed-sky-imported-hourly.csv').read_text(encoding='utf-8')
    if '# mixed_terrain_skyline:' not in text:raise ValueError('Hourly export omitted source evidence')
    artifact={'schema':1,'checkedUTC':datetime.now(timezone.utc).isoformat(),'method':ref['method'],'cases':checked,'hourlyChangedRowsByColumn':changes,'referenceSha256':sha(refpath),
              'codeSha256':{name:sha(ROOT/name) for name in ['pipeline/build_local_sky_reference.py','pipeline/validate_local_sky_exports.py','pipeline/lunar_geo.py','pipeline/test_geodesic.py','app/src/lib/local-sky.ts','app/src/lib/horizon.worker.ts','app/src/lib/data.ts','app/src/lib/terrain.ts','app/src/components/CustomSite.tsx','app/src/components/LocalSkyPanel.tsx','app/src/App.tsx','app/src/lib/share.ts','app/src/lib/export.ts']},
              'limits':['Same source grids and explicitly declared interpolation/sampling; independent geometry is not independent terrain truth.','Imported synthetic heights deliberately have a large datum mismatch; the test verifies propagation and visible seam limits, not a realistic landing choice.','No moving-route physics, flight registration, confidence bounds, independent competitor runtime or human usability result is inferred.']}
    (ROOT/'data/validation/local-sky-check.json').write_text(json.dumps(artifact,indent=2)+'\n',encoding='utf-8',newline='\n')
    print(json.dumps({'cases':len(checked),'horizonValues':sum(v['horizonValues'] for v in checked),'hourlyRows':len(changed),'changedRows':changes}))

if __name__=='__main__':main()
