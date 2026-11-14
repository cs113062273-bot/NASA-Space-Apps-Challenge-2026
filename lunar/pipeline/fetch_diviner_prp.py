"""Fetch the complete, published Diviner south-polar PRP V2 table for spatial sampling.

The manifest records acquired source bytes; this is not a vendor-supplied signature.
Existing files must match the manifest. Intentional source updates require --refresh.
"""
from datetime import datetime, timezone
import argparse
import hashlib
import json
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/raw/research/diviner/prp"
OUT = ROOT / "data/validation/diviner-prp-source.json"
BASE = "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/"
SOURCES = {"dlre_prp_south.tab": "data_derived_prp/dlre_prp_south.tab",
    "dlre_prp_south.xml": "data_derived_prp/dlre_prp_south.xml", "prpds.cat": "catalog/prpds.cat"}


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024*1024), b""):
            h.update(block)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    prior = json.loads(OUT.read_text()) if OUT.exists() else {"files": {}}
    records = {}
    downloaded = False
    with httpx.Client(timeout=httpx.Timeout(60, connect=30), follow_redirects=True) as client:
        for name, resource in SOURCES.items():
            path = CACHE / name
            expected = prior["files"].get(name)
            if path.exists() and expected and not args.refresh:
                if digest(path) != expected["sha256"]:
                    raise ValueError(f"Cached source differs from manifest: {name}")
                records[name] = expected
                print(f"Verified {name}", flush=True)
                continue
            part = path.with_suffix(path.suffix+".part")
            with client.stream("GET", BASE+resource, headers={"Accept-Encoding": "identity"}) as r:
                r.raise_for_status()
                if r.status_code != 200:
                    raise ValueError(f"Expected full source, received HTTP {r.status_code}")
                headers = {key: r.headers.get(key) for key in ["etag", "last-modified", "content-length"]}
                last = 0
                with part.open("wb") as f:
                    for block in r.iter_bytes(1024*1024):
                        f.write(block)
                        if f.tell()-last >= 64*1024*1024:
                            last = f.tell(); print(f"Fetched {name}: {last:,} bytes", flush=True)
            if headers["content-length"] and part.stat().st_size != int(headers["content-length"]):
                raise ValueError(f"Truncated source: {name}")
            if name.endswith(".tab") and part.stat().st_size != 604800210:
                raise ValueError("PRP V2 source differs from audited label length")
            sha = digest(part)
            if expected and not args.refresh and sha != expected["sha256"]:
                raise ValueError(f"Published bytes changed: {name}; review before --refresh")
            part.replace(path)
            downloaded = True
            records[name] = {"url": BASE+resource, "bytes": path.stat().st_size, "sha256": sha, "headers": headers}
            print(f"Saved {name}: {path.stat().st_size:,} bytes", flush=True)
    now = datetime.now(timezone.utc).isoformat()
    OUT.write_text(json.dumps({"acquired_utc": now if downloaded else prior["acquired_utc"], "checked_utc":now, "product": "LRO-L-DLRE-5-PRP-V2.0",
        "provenance": "SHA-256 of acquired official PDS source, not an independently supplied signature", "files": records}, indent=2)+"\n", encoding="utf-8")


if __name__ == "__main__":
    main()
