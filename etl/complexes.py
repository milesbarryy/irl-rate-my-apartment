"""Complex list + survey-name matching shared by the ETL scripts."""
import csv
import re
import unicodedata
from pathlib import Path

# Complexes students named in the survey that are missing from apartment_gdf.csv.
# Coordinates are from OpenStreetMap (Nominatim), looked up once by hand.
EXTRA_COMPLEXES = [
    {"name": "Orchard Park", "zone": "Campus - Privately Owned", "lat": 38.54459, "lon": -121.76528},
    {"name": "Glacier Point", "zone": "West Davis", "lat": 38.56036, "lon": -121.77829},
]

# apartment_gdf.csv places Mission Villas near Sacramento (-121.52), ~13 miles east of
# Davis. Drop the point rather than show it in the wrong city.
BAD_COORDINATES = {"Mission Villas"}

# Survey spellings that normalize differently from the complex list. The backend's
# 80-point fuzzy match maps several of these to the wrong complex (e.g. "Orchard Park"
# -> "Renaissance Park Apartments", "Sharps and Flats" -> "Viking Apartments"), so
# anything not listed here or exactly equal after normalization stays unmatched.
ALIASES = {
    "identity davis": "Identity",
    "fountain circle townhomes": "Fountain Circle",
    "arlington farm": "Arlington Farms",
    "sharps and flats": "Sharp & Flats Apartment Homes",
    "sharp and flats": "Sharp & Flats Apartment Homes",
    "sterling": "Sterling 5th Street",
    "spoke": "The Spoke",
    "pinon": "Piñon",
    "oxford parkside": "Oxford Parkside",
    "davinci court": "DaVinci",
    "drake and anderson court": "The Drake and Anderson Court",
    "wake forest dr": "Wake Forest",
    "villa verde apts": "Villa Verde Apartments",
    "cannery": "The Cannery",
    "oakshade": "Oakshade Commons",
    "orchard park": "Orchard Park",
    "glacier point": "Glacier Point",
}

_SUFFIXES = r"\b(apartment homes|apartments?|apts?|townhomes)\b"


def normalize(name):
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode()
    s = s.lower().replace("&", " and ")
    s = re.sub(_SUFFIXES, " ", s)
    s = re.sub(r"^the\s+", "", s.strip())
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def load_complexes(data_dir):
    out = []
    with (Path(data_dir) / "apartment_gdf.csv").open() as f:
        for r in csv.DictReader(f):
            lat, lon = (float(x) for x in r["coordinates"].split(","))
            name = r["complex"].strip()
            if name in BAD_COORDINATES:
                lat = lon = None
            out.append({"name": name, "zone": r["zone"].strip(), "lat": lat, "lon": lon})
    out.extend(dict(c) for c in EXTRA_COMPLEXES)
    return out


def build_matcher(complexes):
    by_norm = {}
    for c in complexes:
        # First spelling wins, so "Aero" and "Aero Apartments" stay distinct listings.
        by_norm.setdefault(normalize(c["name"]), c["name"])
    by_name = {c["name"] for c in complexes}

    def match(raw):
        if raw is None or (isinstance(raw, float)) or not str(raw).strip():
            return None
        raw = str(raw).strip()
        if raw in by_name:
            return raw
        n = normalize(raw)
        if n in ALIASES:
            return ALIASES[n]
        return by_norm.get(n)

    return match
