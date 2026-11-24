"""Build data/davis_map.json, the simplified base map for the map view.

Input is raw OpenStreetMap JSON from the Overpass API (see README for the queries):
streets.json, extra.json (parks, campus, rail), and b*.json building tiles.

Coordinates are projected to whole meters around a fixed origin so the browser can
draw them without a map library. Apartment points use the same projection (js/map.js).

Usage: python etl/build_map.py path/to/osm_dir
Map data (c) OpenStreetMap contributors, ODbL.
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = (38.5449, -121.7405)  # central Davis
KX = math.cos(math.radians(ORIGIN[0])) * 111320
KY = 110540

CLASS = {
    "motorway": "major", "trunk": "major", "primary": "major", "secondary": "major",
    "motorway_link": "link", "primary_link": "link", "secondary_link": "link",
    "tertiary": "mid",
    "residential": "minor", "unclassified": "minor", "living_street": "minor",
}


def project(pt):
    return [round((pt["lon"] - ORIGIN[1]) * KX), round(-(pt["lat"] - ORIGIN[0]) * KY)]


def simplify(pts, tol):
    """Douglas-Peucker on [[x, y], ...]."""
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy) or 1
    best, idx = 0, 0
    for i in range(1, len(pts) - 1):
        x0, y0 = pts[i]
        d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / norm if (dx or dy) else math.hypot(x0 - x1, y0 - y1)
        if d > best:
            best, idx = d, i
    if best <= tol:
        return [pts[0], pts[-1]]
    return simplify(pts[: idx + 1], tol)[:-1] + simplify(pts[idx:], tol)


def flat(pts):
    return [v for p in pts for v in p]


def dedupe(pts):
    out = []
    for p in pts:
        if not out or out[-1] != p:
            out.append(p)
    return out


def main(osm_dir):
    osm_dir = Path(osm_dir)

    streets = []
    for e in json.load((osm_dir / "streets.json").open())["elements"]:
        cls = CLASS.get(e["tags"].get("highway"))
        if not cls or "geometry" not in e:
            continue
        pts = dedupe(simplify([project(p) for p in e["geometry"]], 1.5))
        if len(pts) >= 2:
            streets.append({"n": e["tags"].get("name", ""), "c": cls, "p": flat(pts)})

    buildings, seen = [], set()
    for f in sorted(osm_dir.glob("b*.json")):
        for e in json.load(f.open())["elements"]:
            if e["id"] in seen or "geometry" not in e:
                continue
            seen.add(e["id"])
            pts = dedupe(simplify([project(p) for p in e["geometry"]], 1.0))
            if len(pts) >= 4:
                buildings.append(flat(pts[:-1]))  # drop closing point; path closes with Z

    parks, campus, rail = [], [], []
    for e in json.load((osm_dir / "extra.json").open())["elements"]:
        tags = e.get("tags", {})
        rings = []
        if e["type"] == "way" and "geometry" in e:
            rings = [e["geometry"]]
        elif e["type"] == "relation":
            rings = [m["geometry"] for m in e.get("members", []) if m.get("role") == "outer" and "geometry" in m]
        for ring in rings:
            pts = dedupe(simplify([project(p) for p in ring], 2))
            if len(pts) < 2:
                continue
            if tags.get("railway") == "rail":
                rail.append(flat(pts))
            elif tags.get("amenity") == "university":
                campus.append(flat(pts))
            elif tags.get("leisure") == "park":
                parks.append(flat(pts))

    xs = [v for s in streets for v in s["p"][0::2]]
    ys = [v for s in streets for v in s["p"][1::2]]
    out = {
        "origin": ORIGIN,
        "k": [KX, KY],
        "bounds": [min(xs), min(ys), max(xs), max(ys)],
        "streets": streets,
        "buildings": buildings,
        "parks": parks,
        "campus": campus,
        "rail": rail,
        "attribution": "© OpenStreetMap contributors",
    }
    with (ROOT / "data" / "davis_map.json").open("w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"{len(streets)} streets, {len(buildings)} buildings, {len(parks)} parks, "
          f"{len(campus)} campus rings, {len(rail)} rail lines")


if __name__ == "__main__":
    main(sys.argv[1])
