"""Fetch the exact named NAIF kernels used by ephemeris.py, with a reproducible SHA-256 manifest.

Default: verify existing cache entries and download missing/mismatched ones from the official source.
--verify: check the local cache only. --refresh-manifest: explicitly refetch all named releases and
record the actual bytes; use for a reviewed initial bootstrap or an intentional source refresh.
This downloads data, never executes remote code.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
KDIR = ROOT / "data" / "raw" / "kernels"
MANIFEST = ROOT / "data" / "validation" / "kernels.json"
BASE = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"
SOURCES = {
    "naif0012.tls": BASE + "lsk/naif0012.tls",
    "pck00011.tpc": BASE + "pck/pck00011.tpc",
    "moon_pa_de440_200625.bpc": BASE + "pck/moon_pa_de440_200625.bpc",
    "moon_de440_250416.tf": BASE + "fk/satellites/moon_de440_250416.tf",
    "de440s.bsp": BASE + "spk/planets/de440s.bsp",
    "earth_1962_260806_2126_combined.bpc": BASE + "pck/earth_1962_260806_2126_combined.bpc",
    "earth_000101_270129_261103.bpc": BASE + "pck/earth_000101_270129_261103.bpc",
    "earthstns_itrf93_260814.bsp": BASE + "spk/stations/earthstns_itrf93_260814.bsp",
}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def fetch_one(name: str, expected: dict | None, refresh: bool, verify: bool) -> dict:
    path = KDIR / name
    if path.parent.resolve() != KDIR.resolve():
        raise ValueError("Kernel target must stay in the raw kernel cache")
    if not refresh and path.is_file() and expected and digest(path) == expected["sha256"]:
        print(f"Verified {name}", flush=True)
        return expected
    if verify:
        raise ValueError(f"Missing or checksum-mismatched kernel: {name}")
    temp = path.with_suffix(path.suffix + ".part")
    request = Request(SOURCES[name], headers={"User-Agent": "LASTLIGHT-data-builder/0.1"})
    with urlopen(request, timeout=60) as response, temp.open("wb") as destination:
        advertised = response.headers.get("Content-Length")
        for block in iter(lambda: response.read(1024 * 1024), b""):
            destination.write(block)
    size = temp.stat().st_size
    actual = digest(temp)
    if advertised is not None and size != int(advertised):
        raise ValueError(f"Truncated download for {name}: {size} bytes")
    if size == 0 or (expected and not refresh and actual != expected["sha256"]):
        raise ValueError(f"Unexpected source bytes for {name}; review before refreshing the manifest")
    temp.replace(path)
    print(f"Fetched {name}: {size:,} bytes", flush=True)
    return {"url": SOURCES[name], "bytes": size, "sha256": actual}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--verify", action="store_true")
    group.add_argument("--refresh-manifest", action="store_true")
    group.add_argument("--extend-manifest", action="store_true", help="Verify pinned files and record newly added named sources")
    args = parser.parse_args()
    if not MANIFEST.exists() and not (args.refresh_manifest or args.extend_manifest):
        parser.error("No checksum manifest: bootstrap from official sources with --refresh-manifest")
    expected = json.loads(MANIFEST.read_text(encoding="utf-8"))["kernels"] if MANIFEST.exists() else {}
    if set(SOURCES) - set(expected) and not (args.refresh_manifest or args.extend_manifest):
        parser.error("New named kernel sources require --extend-manifest before normal fetch/verify")
    KDIR.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {name: pool.submit(fetch_one, name, expected.get(name), args.refresh_manifest, args.verify) for name in SOURCES}
        records = {name: future.result() for name, future in futures.items()}
    if args.refresh_manifest or args.extend_manifest:
        MANIFEST.write_text(json.dumps({"retrieved_utc": datetime.now(timezone.utc).isoformat(),
            "source": "Official NASA/JPL NAIF generic-kernel archive; named releases, not moving latest aliases",
            "kernels": records}, indent=2) + "\n", encoding="utf-8")
        print(f"Recorded {MANIFEST.relative_to(ROOT)}", flush=True)


if __name__ == "__main__":
    main()
