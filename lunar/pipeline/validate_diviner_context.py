"""Re-fetch selected source records by exact byte offset and parse XML fixed-field columns.

This is separate from the full-table NumPy CSV parser and checks source/column alignment.
It is still the same scientific product, not an independent measured-temperature validation.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

import httpx

ROOT = Path(__file__).resolve().parents[1]
NS = {"p":"http://pds.nasa.gov/pds4/pds/v1"}


def main():
    context = json.loads((ROOT / "app/public/data/diviner-prp-sites.json").read_text())
    spatial = json.loads((ROOT / "data/validation/diviner-prp-spatial.json").read_text())
    raw_dir = ROOT / "data/raw/research/diviner/prp"
    label = (raw_dir / "dlre_prp_south.xml").read_bytes()
    if hashlib.sha256(label).hexdigest() != context["label"]["sha256"]:
        raise ValueError("Source label differs from packaged context")
    table = ET.fromstring(label).find(".//p:Table_Character",NS)
    offset = int(table.findtext("p:offset",namespaces=NS))
    record = table.find("p:Record_Character",NS)
    width = int(record.findtext("p:record_length",namespaces=NS))
    fields = [(f.findtext("p:name",namespaces=NS),int(f.findtext("p:field_location",namespaces=NS))-1,
        int(f.findtext("p:field_length",namespaces=NS))) for f in record.findall("p:Field_Character",NS)]
    rows = []
    with httpx.Client(timeout=30) as client:
        for case in spatial["cases"]:
            sample = next(s for s in context["sites"] if s["id"] == case["site"])
            start = offset + sample["facet_index"]*width
            end = start+width-1
            headers = {"Range":f"bytes={start}-{end}","Accept-Encoding":"identity",
                "If-Range":context["source"]["headers"]["etag"]}
            with client.stream("GET",context["source"]["url"],headers=headers) as r:
                if r.status_code != 206 or r.headers.get("content-range") != f"bytes {start}-{end}/{context['source']['bytes']}":
                    raise ValueError(f"Source changed or unexpected range: {r.status_code}, {r.headers.get('content-range')}")
                raw = r.read()
            if len(raw) != width:
                raise ValueError("Truncated source record")
            parsed = {name:float(raw[a:a+n]) for name,a,n in fields}
            for key,value in zip(parsed,case["source_values"]):
                if parsed[key] != value:
                    raise ValueError(f"CSV and fixed-field source parsers disagree: {case['site']} / {key}")
            if parsed["temp_avg"] != sample["annual_mean_2cm_k"] or parsed["temp_max"] != sample["annual_surface_max_k"]:
                raise ValueError("Packaged temperatures differ from remote source row")
            (raw_dir/f"{case['site']}-record-{sample['facet_index']}.txt").write_bytes(raw)
            rows.append(dict(site=case["site"],facet_index=sample["facet_index"],source_record_number=sample["source_record_number"],
                byte_start=start,byte_end=end,sha256=hashlib.sha256(raw).hexdigest(),fixed_field_values=parsed))
            print(f"Verified remote source row {sample['source_record_number']}: {case['site']}",flush=True)
    report = dict(checked_utc=datetime.now(timezone.utc).isoformat(),source_sha256=context["source"]["sha256"],
        method="HTTP byte-range fetch at the selected source offset; PDS4 XML fixed-field parser vs full-table CSV parser",
        scope="Source record/column alignment; same product, no measured-temperature or registration validation",cases=rows)
    (ROOT / "data/validation/diviner-prp-range-check.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")


if __name__ == "__main__":
    main()
