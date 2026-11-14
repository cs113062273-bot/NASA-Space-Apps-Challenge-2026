"""Package source-traceable annual PRP context at curated sites, not a mission forecast.

Requires the full table fetched by fetch_diviner_prp.py. Builds a KD tree only as a
candidate accelerator, then tests exact triangle containment. Independent full-table
half-space searches validate selected sites. No table/grid ordering is assumed.
"""
from datetime import datetime, timezone
import json
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

import diviner_prp as G
import fetch_diviner_prp as F

ROOT = Path(__file__).resolve().parents[1]


def main():
    manifest = json.loads(F.OUT.read_text())
    for name, source in manifest["files"].items():
        if F.digest(F.CACHE / name) != source["sha256"]:
            raise ValueError(f"PRP source checksum mismatch: {name}")
    path = F.CACHE / "dlre_prp_south.tab"
    cache = F.CACHE / "parsed-f64.npy"
    sha = manifest["files"][path.name]["sha256"]
    marker = F.CACHE / "parsed-source.json"
    cached = json.loads(marker.read_text()) if marker.exists() else {}
    if not cache.exists() or cached.get("source_sha256") != sha:
        print("Parsing 2,880,000 published facets", flush=True)
        values = np.loadtxt(path, delimiter=",", skiprows=1, dtype=np.float64)
        np.save(cache,values)
        marker.write_text(json.dumps({"source_sha256":sha,"parsed_sha256":F.digest(cache)})+"\n")
    elif F.digest(cache) != cached.get("parsed_sha256"):
        raise ValueError("Parsed PRP cache checksum mismatch; remove/rebuild that cache after review")
    values = np.load(cache, mmap_mode="r")
    if values.shape != (2880000,15) or not np.isfinite(values).all():
        raise ValueError("Unexpected/nonfinite PRP table")
    vertices = values[:,:9].reshape(-1,3,3)
    la, lo = np.deg2rad(values[:,10]), np.deg2rad(values[:,9])
    centres = np.column_stack([np.cos(la)*np.cos(lo),np.cos(la)*np.sin(lo),np.sin(la)])
    tree = cKDTree(centres)
    sites = json.loads((ROOT / "app/public/data/sites.json").read_text())["sites"]
    rows, crosschecks = [], []
    for s in sites:
        p = G.direction(s["lat"],s["lon"])
        _, candidate = tree.query(p,k=32)
        found = [(int(k),G.ray_triangle(p,vertices[k])) for k in candidate]
        found = [(k,result) for k,result in found if result is not None]
        # Deterministic tie at a shared boundary; no extrapolation beyond the mesh.
        found.sort(key=lambda pair: pair[0])
        if not found:
            rows.append(dict(id=s["id"],lat=s["lat"],lon=s["lon"],status="outside-published-mesh"))
            continue
        index, (weights,radius) = found[0]
        row = values[index]
        if not G.contains_by_edges(p,vertices[index]):
            raise ValueError("Ray and edge-containment methods disagree")
        near = np.asarray(tree.query_ball_point(p,2*np.sin(1/(2*G.RADIUS_KM))),dtype=int)
        # Nearby means centre within 1 km, not an ellipse probability or footprint union.
        averages, maxima = values[near,12], values[near,13]
        if not (0 < row[12] < 500 and 0 < row[13] < 500) or row[13] < row[12]:
            raise ValueError("Invalid source temperature at sampled facet")
        context = dict(id=s["id"],lat=s["lat"],lon=s["lon"],status="sampled",
            facet_index=index, source_record_number=index+1, centre_lat=float(row[10]), centre_lon=float(row[9]),
            centre_distance_m=G.great_circle_m(p,centres[index]),
            annual_mean_2cm_k=float(row[12]), annual_surface_max_k=float(row[13]),
            ice_stability_depth_m=None if row[14] == -999 else float(row[14]),
            vertices_km=vertices[index].tolist(), barycentric_weights=weights.tolist(), ray_radius_km=radius,
            neighborhood=dict(radius_m=1000, selection="facet centres within radius", count=len(near),
                annual_mean_2cm_min_k=float(averages.min()), annual_mean_2cm_max_k=float(averages.max()),
                annual_surface_max_min_k=float(maxima.min()), annual_surface_max_max_k=float(maxima.max())))
        rows.append(context)
        print(f"{s['id']}: facet {index}, mean2cm {row[12]:.3f} K, surface max {row[13]:.3f} K, centre {context['centre_distance_m']:.1f} m",flush=True)
        if s["id"] in ["c1","shackleton","im2-actual","a3-degerlache-2"]:
            all_inside = []
            for a in range(0,len(vertices),100000):
                k = np.flatnonzero(G.contains_by_edges(p,vertices[a:a+100000])) + a
                all_inside.extend(k.tolist())
            if index not in all_inside or len(all_inside)>2:
                raise ValueError(f"Global independent containment failed at {s['id']}: {all_inside}")
            crosschecks.append(dict(site=s["id"],selected_facet=index,full_table_edge_matches=all_inside,
                source_values=row.tolist(), center_distance_m=context["centre_distance_m"]))
    product = dict(schema=1, product="LRO-L-DLRE-5-PRP-V2.0", data_type="annual thermal model fitted to first mapping-year Diviner observations",
        terrain="Kaguya laser-altimeter triangular mesh; not the application's LOLA/LROC terrain",
        coordinate_note="Published Moon-centred vertices and planetocentric east longitude/latitude; exact frame/terrain registration to current site data is unresolved. Context only.",
        source=manifest["files"][path.name], label=manifest["files"]["dlre_prp_south.xml"], catalog=manifest["files"]["prpds.cat"],
        built_utc=datetime.now(timezone.utc).isoformat(),
        sampling="geocentric site ray intersects a published triangle; facet value retained without interpolation; zero-based facet_index; source_record_number is 1-based data row after header",
        limits=["Not a mission-date temperature forecast or equipment-node temperature", "Annual mean is at 2 cm depth; annual maximum is at the surface",
            "Model-calculated ice-stability depth is not an ice detection; source -999 maps to null", "Published V1 is invalid; only V2 is used",
            "Neighbourhood spans are context, not a confidence interval or landing safety probability", "No automatic thermal boundary or mission pass/fail is derived"], sites=rows)
    (ROOT / "app/public/data/diviner-prp-sites.json").write_text(json.dumps(product,indent=2)+"\n",encoding="utf-8")
    report = dict(source_sha256=sha, method="KD-tree candidate selection + Moller-Trumbore ray intersection; independent full-table spherical half-space scan at four sites",
        source_rows=len(values), sampled_sites=sum(r["status"]=="sampled" for r in rows), outside_sites=sum(r["status"]!="sampled" for r in rows),
        cases=crosschecks, scope="Spatial software/data cross-check, not measured temperature or frame-registration validation")
    (ROOT / "data/validation/diviner-prp-spatial.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
    print(f"Packaged {report['sampled_sites']} sampled / {report['outside_sites']} outside sites",flush=True)


if __name__ == "__main__":
    main()
