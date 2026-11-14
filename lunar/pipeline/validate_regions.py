"""Do NASA's nine Artemis III region boxes sit where our maps say the Sun and Earth are best?

Uses the polar layer values (layers.u8: 2027 average sunlight and Earth-in-view share, 1 km grid, +/- 200 km)
and the digitised region boxes in sites.json. For the top 1% / 0.5% / 0.1% of grid cells ranked by a score,
reports the share inside the boxes and how many times that exceeds the boxes' share of the area (chance).
Output: data/validation/regions-vs-layers.json
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "app" / "public" / "data"


def main():
    lv = json.loads((DATA / "basemap.json").read_text())["layer_values"]
    n, half, step = lv["n"], lv["half_extent_m"], lv["step_m"]
    u8 = np.fromfile(DATA / lv["file"], np.uint8).reshape(2, n, n)
    sun, earth = u8[0] / lv["scale"], u8[1] / lv["scale"]
    xs = np.arange(-half, half + 1, step)
    X, Y = np.meshgrid(xs, xs[::-1])
    disc = (u8[0] < 255) & (u8[1] < 255) & (np.hypot(X, Y) <= half)
    inbox = np.zeros_like(disc)
    boxes = [s["region_xy"] for s in json.loads((DATA / "sites.json").read_text())["sites"] if s.get("region_xy")]
    for x1, x2, y1, y2 in boxes:
        inbox |= (X >= x1) & (X <= x2) & (Y >= y1) & (Y <= y2)
    area = float((inbox & disc).sum() / disc.sum())
    out = {"regions": len(boxes), "disc_radius_km": half / 1000, "area_share_pct": round(area * 100, 1), "scores": {}}
    for name, score in [("sun_and_earth", np.minimum(sun, earth)), ("earth", earth), ("sun", sun)]:
        rows = []
        for top in (1.0, 0.5, 0.1):
            thr = np.quantile(score[disc], 1 - top / 100)
            sel = disc & (score >= thr)
            share = float((sel & inbox).sum() / sel.sum())
            rows.append({"top_pct": top, "threshold_pct": round(float(thr) * 100, 1), "cells": int(sel.sum()),
                         "inside_pct": round(share * 100, 1), "times_chance": round(share / area, 1)})
        out["scores"][name] = rows
    dest = ROOT / "data" / "validation" / "regions-vs-layers.json"
    dest.write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
