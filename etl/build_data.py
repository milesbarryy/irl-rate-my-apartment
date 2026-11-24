"""Build data/properties.json from IRL's annual housing survey (2024-2026).

Usage: python etl/build_data.py path/to/irl-housing-dashboard-backend/data

Privacy: only the fields listed in `review()` leave this script. IP addresses, emails,
respondent geolocation, response IDs and every free-text answer stay in the backend.

Rating rubric (all on a 1-5 scale; 5 = best)
-------------------------------------------
Each survey satisfaction item is scored Very dissatisfied = 1 ... Very satisfied = 5.
Items are grouped into four categories a student would weigh when choosing housing:

  Maintenance & Management  "Maintenance" (2024) / "Maintenance/Management" (2025-26)
  Location & Access         access to grocery store, bus stop, entertainment, and
                            campus (campus asked 2026 only)
  Livability                quietness, safety, and spaciousness (2024) / privacy (2025)
  Value                     "Was your housing worth the cost?"  Yes = 5, No = 1, so a
                            property's score is 1 + 4 x (share answering Yes)

A response's category score is the mean of the items it answered in that category. A
property's category score is the mean over its responses; its overall score is the mean
of its available category scores. Roommate relationships were left out on purpose:
they describe the respondent's roommates, not the property.
"""
import json
import math
import sys
from collections import Counter
from pathlib import Path

import pandas as pd

from complexes import build_matcher, load_complexes

ROOT = Path(__file__).resolve().parent.parent
CAMPUS = (38.54237, -121.74957)  # UC Davis Memorial Union

LIKERT = {
    "very dissatisfied": 1, "dissatisfied": 2, "somewhat dissatisfied": 2,
    "neither": 3, "neutral": 3, "satisfied": 4, "very satisfied": 5,
}

# survey column -> rubric item, per year (from etl_processing.py's amenity maps)
ITEMS = {
    2024: {
        "qualityOfLife_1": "grocery", "qualityOfLife_2": "bus", "qualityOfLife_3": "entertainment",
        "qualityOfLife_4": "maintenance", "qualityOfLife_6": "quiet", "qualityOfLife_7": "safety",
        "qualityOfLife_8": "space",
    },
    2025: {
        "qualityOfLife_1": "grocery", "qualityOfLife_2": "bus", "qualityOfLife_3": "entertainment",
        "qualityOfLife_4": "maintenance", "qualityOfLife_6": "quiet", "qualityOfLife_7": "safety",
        "qualityOfLife_8": "privacy",
    },
    2026: {
        "amenities_rate_1": "grocery", "amenities_rate_2": "bus", "amenities_rate_3": "entertainment",
        "amenities_rate_4": "campus", "amenities_rate_5": "maintenance", "amenities_rate_6": "quiet",
        "amenities_rate_7": "safety",
    },
}

CATEGORIES = {
    "maintenance": ["maintenance"],
    "location": ["grocery", "bus", "entertainment", "campus"],
    "livability": ["quiet", "safety", "space", "privacy"],
}

ISSUE_COL = {2025: "Q40", 2026: "issues"}
IMPROVE_COL = {2026: "quality_improve"}
KNOWN_ISSUES = {
    "Mold", "Broken Appliance", "Lighting/Electricity", "Plumbing", "AC/Heating",
    "Trash/Waste Disposal", "Issue with deposit returns", "Lack of Communication",
}
BUS_2024 = ["A", "B", "C", "D", "E", "F", "G", "J", "K", "L", "M", "O", "P", "Q", "U",
            "V", "VL", "VX", "W", "Z", "42A", "42B"]
TRANSIT = {"transportationType_1": "Bike", "transportationType_2": "Bus",
           "transportationType_3": "Drive", "transportationType_4": "Walk"}


def clean(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return v


def split_multi(v):
    v = clean(v)
    if v is None:
        return []
    # Multi-select answers are comma-joined; options themselves contain ", " only in
    # the "Self-Guided Search (...)" discovery option, which we don't split here.
    return [x.strip() for x in str(v).split(",") if x.strip()]


def bed_config(v):
    v = clean(v)
    if v is None:
        return None
    v = str(v)
    for key in ("Single", "Double", "Triple", "Studio"):
        if v.startswith(key):
            return key
    return "Other"


def miles(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def median(xs):
    xs = sorted(xs)
    if not xs:
        return None
    m = len(xs) // 2
    return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2


def r1(x):
    return None if x is None else round(x, 2)


def review(row, year, prop):
    items = {}
    for col, item in ITEMS[year].items():
        s = LIKERT.get(str(row.get(col, "")).strip().lower())
        if s is not None:
            items[item] = s

    worth = clean(row.get("worth"))
    scores = {cat: mean([items.get(i) for i in its]) for cat, its in CATEGORIES.items()}
    scores["value"] = {"Yes": 5.0, "No": 1.0}.get(worth)

    rent = clean(row.get("monthlyRent"))
    # Drop $0 (RAs, CAs, family-owned) and implausible per-person rents.
    rent = float(rent) if rent is not None and 150 <= float(rent) <= 4000 else None

    issues = []
    if year in ISSUE_COL:
        for x in split_multi(row.get(ISSUE_COL[year])):
            x = x.rstrip(":")
            issues.append(x if x in KNOWN_ISSUES else "Other")

    if year == 2024:
        buses = [b for b in BUS_2024 if row.get(b) == 1]
    else:
        buses = split_multi(row.get("busLines"))

    ranks = {mode: clean(row.get(col)) for col, mode in TRANSIT.items()}
    primary = min((r, m) for m, r in ranks.items() if r is not None)[1] if any(
        r is not None for r in ranks.values()) else None

    return {
        "property": prop,
        "surveyYear": year,
        "moveIn": clean(row.get("startYear")),
        "bed": bed_config(row.get("bedroomConfig")),
        "rent": rent,
        "items": items,
        "scores": {k: r1(v) for k, v in scores.items()},
        "worth": worth,
        "issues": sorted(set(issues)),
        "improve": split_multi(row.get(IMPROVE_COL.get(year))),
        "commute": clean(row.get("commuteTime")),
        "transit": primary,
        "buses": buses,
    }


def main(data_dir):
    data_dir = Path(data_dir)
    complexes = {c["name"]: c for c in load_complexes(data_dir)}
    match = build_matcher(complexes.values())

    addresses = {}
    addr_file = Path(__file__).parent / "addresses.csv"
    if addr_file.exists():
        addresses = pd.read_csv(addr_file).fillna("").set_index("complex")["address"].to_dict()

    reviews = []
    for year in (2024, 2025, 2026):
        df = pd.read_csv(data_dir / f"housing{year}.csv", dtype={"startYear": str})
        if "DistributionChannel" in df:
            df = df[df["DistributionChannel"] != "preview"]
        if "prerequisites" in df:
            df = df[df["prerequisites"] != "No"]  # screened out of the survey
        for _, row in df.iterrows():
            prop = match(row.get("apartmentName"))
            if prop:
                reviews.append(review(row.to_dict(), year, prop))

    by_prop = {}
    for r in reviews:
        by_prop.setdefault(r["property"], []).append(r)

    properties = []
    for name, rs in by_prop.items():
        c = complexes[name]
        cats = {cat: mean([r["scores"][cat] for r in rs]) for cat in ("maintenance", "location", "livability", "value")}
        cat_n = {cat: sum(r["scores"][cat] is not None for r in rs) for cat in cats}
        overall = mean(list(cats.values()))
        rents = [r["rent"] for r in rs if r["rent"]]
        rent_by_bed = {}
        for bed in ("Single", "Double", "Triple", "Studio"):
            xs = [r["rent"] for r in rs if r["rent"] and r["bed"] == bed]
            if xs:
                rent_by_bed[bed] = {"median": round(median(xs)), "n": len(xs)}
        with_issue_q = [r for r in rs if r["surveyYear"] in ISSUE_COL]
        issue_counts = Counter(i for r in with_issue_q for i in r["issues"])
        worth = [r["worth"] for r in rs if r["worth"]]
        properties.append({
            "id": name.lower().replace("&", "and").replace(" ", "-").replace(".", "").replace("ñ", "n"),
            "name": name,
            "zone": c["zone"],
            # Reverse-geocoded, so the house number is only approximate: show the street,
            # search on the full string.
            "address": addresses.get(name, ""),
            "street": addresses.get(name, "").lstrip("0123456789- ").strip(),
            "lat": c["lat"],
            "lon": c["lon"],
            "distance": None if c["lat"] is None else round(miles(CAMPUS, (c["lat"], c["lon"])), 2),
            "n": len(rs),
            "years": sorted({r["surveyYear"] for r in rs}),
            "overall": r1(overall),
            "scores": {k: r1(v) for k, v in cats.items()},
            "scoreN": cat_n,
            "rent": {"median": round(median(rents)) if rents else None, "n": len(rents), "byBed": rent_by_bed},
            "worthPct": round(100 * worth.count("Yes") / len(worth)) if worth else None,
            "issueResponses": len(with_issue_q),
            "issuePct": round(100 * sum(bool(r["issues"]) for r in with_issue_q) / len(with_issue_q)) if with_issue_q else None,
            "topIssues": [{"issue": k, "n": v} for k, v in issue_counts.most_common(4)],
            "commute": Counter(r["commute"] for r in rs if r["commute"]).most_common(1)[0][0] if any(r["commute"] for r in rs) else None,
            "buses": [b for b, _ in Counter(b for r in rs for b in r["buses"]).most_common(4)],
        })

    properties.sort(key=lambda p: (-p["n"], p["name"]))
    all_rents = sorted(r["rent"] for r in reviews if r["rent"])

    out = {
        "generated": pd.Timestamp.now().strftime("%Y-%m-%d"),
        "campus": {"name": "Memorial Union", "lat": CAMPUS[0], "lon": CAMPUS[1]},
        "surveyResponses": len(reviews),
        "rents": all_rents,
        "properties": properties,
        "reviews": [{k: v for k, v in r.items() if k != "items"} | {"items": r["items"]} for r in reviews],
    }
    (ROOT / "data").mkdir(exist_ok=True)
    with (ROOT / "data" / "properties.json").open("w") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    print(f"{len(properties)} properties, {len(reviews)} reviews, {len(all_rents)} rents")


if __name__ == "__main__":
    main(sys.argv[1])
