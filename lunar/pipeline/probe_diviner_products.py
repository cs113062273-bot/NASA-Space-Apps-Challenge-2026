"""Audit PDS Diviner product labels and tiny record previews, without full table downloads.

This is a source/format investigation. It does not select a landing site's pixel,
interpolate thermal data or turn a multi-year product into a temperature forecast.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

import httpx

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/"
PRODUCTS = ["data_derived_pcp/seasonal/slon/pols/pcp_avg_tbol_pols_ls030_slon01_240",
    "data_derived_prp/dlre_prp_south"]
NS = {"p": "http://pds.nasa.gov/pds4/pds/v1"}


def hash_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def main():
    cache = ROOT / "data/raw/research/diviner/source-audit"
    cache.mkdir(parents=True, exist_ok=True)
    rows = []
    with httpx.Client(timeout=30) as client:
        for stem in PRODUCTS:
            url = BASE + stem
            label = client.get(url + ".xml")
            label.raise_for_status()
            tree = ET.fromstring(label.content)
            table = tree.find(".//p:Table_Character", NS)
            if table is None:
                raise ValueError(f"No fixed character table in {url}")
            offset = int(table.findtext("p:offset", namespaces=NS))
            records = int(table.findtext("p:records", namespaces=NS))
            record = table.find("p:Record_Character", NS)
            length = int(record.findtext("p:record_length", namespaces=NS))
            fields = [dict(name=f.findtext("p:name", namespaces=NS),
                location=int(f.findtext("p:field_location", namespaces=NS)),
                length=int(f.findtext("p:field_length", namespaces=NS)),
                description=f.findtext("p:description", default="", namespaces=NS).strip())
                for f in record.findall("p:Field_Character", NS)]
            # Use streaming so a server ignoring Range cannot accidentally download a 600 MB table.
            end = offset + 3 * length - 1
            with client.stream("GET", url + ".tab", headers={"Range": f"bytes=0-{end}", "Accept-Encoding": "identity"}) as response:
                if response.status_code != 206:
                    raise ValueError(f"Range unsupported ({response.status_code}); full download deliberately not attempted: {url}")
                content_range = response.headers.get("Content-Range", "")
                match = re.fullmatch(r"bytes 0-(\d+)/(\d+)", content_range)
                if not match or int(match[1]) != end:
                    raise ValueError(f"Unexpected range: {content_range}")
                total = int(match[2])
                if total != offset + records * length:
                    raise ValueError("Table byte count differs from label")
                raw = response.read()
                if len(raw) != end + 1:
                    raise ValueError("Truncated preview")
                headers = {k: response.headers.get(k) for k in ["etag", "last-modified", "content-range"]}
            preview = []
            for k in range(3):
                line = raw[offset+k*length:offset+(k+1)*length]
                preview.append({f["name"]: float(line[f["location"]-1:f["location"]-1+f["length"]]) for f in fields})
            name = stem.split("/")[-1]
            (cache / (name + ".xml")).write_bytes(label.content)
            (cache / (name + ".preview")).write_bytes(raw)
            row = dict(product=name, label_url=url+".xml", label_sha256=hash_bytes(label.content), table_url=url+".tab",
                table_description=table.findtext("p:description", default="", namespaces=NS).strip(),
                rows=records, row_bytes=length, header_bytes=offset, source_bytes=total,
                preview_sha256=hash_bytes(raw), preview_bytes=len(raw), preview_record_indices=[0,1,2], headers=headers,
                fields=fields, preview=preview)
            rows.append(row)
            print(f"{name}: {records:,} rows × {length} bytes; inspected {len(raw):,} of {total:,} table bytes", flush=True)
    result = dict(checked_utc=datetime.now(timezone.utc).isoformat(),
        scope="Source labels/format and first-three-record previews only; no site sampling, temporal interpolation, spatial validation or boundary selection",
        interpretation={"PCP": "Multi-year bolometric brightness averages binned by season and subsolar longitude; empty spatial bins omitted; not a mission-day equipment temperature",
            "PRP": "Model-calculated annual average at 2 cm, annual surface maximum and ice-stability depth; not instantaneous measurements or confirmed ice; exclusion value -999 applies to ice depth"},
        products=rows)
    (ROOT / "data/validation/diviner-source-audit.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")


if __name__ == "__main__":
    main()
