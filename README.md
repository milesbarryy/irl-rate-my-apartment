# RateMyApartment Davis

A RateMyProfessor-style site for Davis apartments, built on ASUCD Innovation and Research Lab's
annual housing survey (2024–2026). Students can filter and compare complexes, read the survey
responses for each property, and see every reviewed property on a simple map of Davis.

Static site: no build step and no server. Open it with any static file server:

```bash
python3 -m http.server 8000
```

then visit http://localhost:8000.

## What's here

| Path | What it is |
| --- | --- |
| `index.html`, `css/`, `js/` | The site. `js/app.js` handles filters, cards, search and the review dialogs; `js/map.js` draws the map with d3-zoom. |
| `data/properties.json` | Per-property scores, rents and anonymized per-response records. Generated. |
| `data/davis_map.json` | Simplified streets, buildings, parks and campus outline from OpenStreetMap. Generated. |
| `etl/build_data.py` | Survey CSVs → `properties.json`. The rating rubric is documented at the top of this file. |
| `etl/complexes.py` | Complex list, name normalization and aliases for matching survey answers to complexes. |
| `etl/build_map.py` | OSM Overpass JSON → `davis_map.json`. |
| `etl/geocode_addresses.py`, `etl/addresses.csv` | Approximate street for each complex (OSM Nominatim reverse geocoding), used for address search. |

## Rebuilding the data

The survey data lives in the private
[irl-housing-dashboard-backend](https://github.com/ASUCD-IRL/irl-housing-dashboard-backend) repo.

```bash
pip install pandas
python etl/build_data.py ../irl-housing-dashboard-backend/data
```

Only aggregated scores and anonymized per-response fields leave the ETL. IP addresses, emails,
respondent locations, response IDs and all free-text answers are dropped.

To refresh the base map, download these three Overpass queries (bbox `38.525,-121.80,38.585,-121.68`)
into one folder: `highway` ways (motorway through residential) as `streets.json`; `building`
ways as `b1.json`…`bN.json` (tile the bbox if the server times out); and parks,
`amenity=university` and `railway=rail` as `extra.json`. Then run:

```bash
python etl/build_map.py path/to/osm_folder
```

## Rating rubric

Survey satisfaction items (Very dissatisfied = 1 … Very satisfied = 5) are grouped into:

- **Maintenance**: maintenance / property management
- **Location**: access to grocery store, bus stop, entertainment, campus
- **Livability**: quietness, safety, spaciousness (2024) / privacy (2025)
- **Value**: "Was your housing worth the cost?" (Yes = 5, No = 1)

Overall = mean of the four. "Highest rated" sorting shrinks each score toward the citywide
mean (5-response prior), so single glowing responses don't top the list. Properties with fewer
than 5 responses are flagged *limited data*.

## Known gaps

- **Houses aren't listed.** The survey only records a neighborhood for houses, not an address.
- **Sign-in and review submission are stubs.** "Sign in (SSO)" offers a demo mode, and new
  reviews are saved in the student's browser (localStorage). Connecting UC Davis CAS and a
  write endpoint on the backend is the next step.
- **Unmatched names.** About 60 responses name a complex that isn't in `apartment_gdf.csv`
  (e.g. "Sterling Pointe", "Brisa Villas") or just say "Other". Add aliases or complexes in
  `etl/complexes.py`.
- **Mission Villas** has coordinates near Sacramento in `apartment_gdf.csv`, so it's left
  off the map until they're corrected.
- Distances are straight-line miles to the Memorial Union, not travel distance.

Map data © OpenStreetMap contributors (ODbL).
