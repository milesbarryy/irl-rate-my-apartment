"""Reverse-geocode each complex's coordinates to an approximate street address.

Addresses come from OpenStreetMap Nominatim and are cached in etl/addresses.csv so
the site build never needs network access. Re-run only when the complex list changes.

Usage: python etl/geocode_addresses.py path/to/irl-housing-dashboard-backend/data
"""
import csv
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from complexes import load_complexes

OUT = Path(__file__).parent / "addresses.csv"
URL = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&"


def reverse(lat, lon):
    req = urllib.request.Request(
        URL + urllib.parse.urlencode({"lat": lat, "lon": lon}),
        headers={"User-Agent": "ASUCD-IRL-rate-my-apartment/1.0"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        a = json.load(resp).get("address", {})
    street = " ".join(x for x in [a.get("house_number"), a.get("road")] if x)
    return street


def main(data_dir):
    cached = {}
    if OUT.exists():
        with OUT.open() as f:
            cached = {r["complex"]: r["address"] for r in csv.DictReader(f)}

    rows = []
    for c in load_complexes(data_dir):
        name = c["name"]
        if name in cached:
            rows.append({"complex": name, "address": cached[name]})
            continue
        if c["lat"] is None:
            rows.append({"complex": name, "address": ""})
            continue
        try:
            addr = reverse(c["lat"], c["lon"])
        except Exception as e:  # keep going; a blank address just isn't searchable
            print(f"  ! {name}: {e}")
            addr = ""
        print(f"{name:40s} {addr}")
        rows.append({"complex": name, "address": addr})
        time.sleep(1.1)  # Nominatim usage policy: max 1 request/second

    with OUT.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["complex", "address"])
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
