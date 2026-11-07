#!/usr/bin/env python3
"""
U3: turn the raw sightings in data/ into BLURRED zones and load them into Atlas.

  pip install pymongo python-dotenv
  (backend/.env must have MONGODB_URI=mongodb+srv://...)
  python seed_zones.py            -> loads Atlas
  python seed_zones.py --dry-run  -> just prints the zones

Privacy (U6/U10): every sighting is snapped to a ~1 km grid cell. Only the cell
centre is stored - exact sighting coordinates never reach the database.
"""
import json
import math
import os
import pathlib
import sys
from collections import defaultdict

HERE = pathlib.Path(__file__).parent
DATA = HERE / "data"
GRID_DEG = 0.01          # ~1.1 km north-south; same value as main.py

RAPTOR_WORDS = ("hawk", "eagle", "falcon", "osprey", "kite", "harrier", "kestrel", "merlin")
COLONY_WORDS = ("tern", "gull", "skimmer", "heron", "egret", "cormorant", "pelican")


def snap(lat, lon):
    f = lambda v: round((math.floor(v / GRID_DEG) + 0.5) * GRID_DEG, 4)
    return f(lat), f(lon)


def load(name):
    p = DATA / name
    return json.loads(p.read_text()) if p.exists() else None


def ebird_sightings(rows, spot):
    for r in rows or []:
        if "lat" in r and "lng" in r:
            yield {"spot": spot, "lat": r["lat"], "lon": r["lng"],
                   "name": r.get("comName", ""), "date": (r.get("obsDt") or "")[:10],
                   "count": r.get("howMany") or 1}


def inat_sightings(blob, spot):
    for r in (blob or {}).get("results", []):
        loc = r.get("location")                       # "lat,lon"
        if not loc:
            continue
        lat, lon = map(float, loc.split(","))
        taxon = r.get("taxon") or {}
        yield {"spot": spot, "lat": lat, "lon": lon,
               "name": taxon.get("preferred_common_name") or taxon.get("name", ""),
               "date": r.get("observed_on") or "", "count": 1}


def build_zones():
    sightings = []
    sightings += ebird_sightings(load("rpi_ebird_recent.json"), "rpi")
    sightings += ebird_sightings(load("bolsa_ebird_2021-05-13.json"), "bolsa")
    sightings += inat_sightings(load("rpi_inat.json"), "rpi")
    sightings += inat_sightings(load("bolsa_inat_may2021.json"), "bolsa")

    cells = defaultdict(list)
    for s in sightings:
        cells[(s["spot"],) + snap(s["lat"], s["lon"])].append(s)

    zones = []
    for (spot, lat, lon), group in cells.items():
        names = sorted({g["name"] for g in group if g["name"]})
        low = [n.lower() for n in names]
        raptors = any(w in n for n in low for w in RAPTOR_WORDS)
        colony = any(w in n for n in low for w in COLONY_WORDS)
        n = len(group)
        # placeholder level until the real score (U4) - the score can overwrite it
        level = "red" if (raptors or colony or n >= 15) else "yellow" if n >= 3 else "green"
        if level == "green":
            continue                                   # quiet cells aren't zones
        zones.append({
            "cell_id": f"{spot}:{lat}:{lon}",
            "spot": spot,
            "lat": lat, "lon": lon,
            "loc": {"type": "Point", "coordinates": [lon, lat]},   # GeoJSON is [lon, lat]
            "radius_m": 500,                           # half a grid cell
            "level": level,
            "sightings": n,
            "raptors": raptors,
            "colony": colony,
            "species": names[:15],
            "latest": max((g["date"] for g in group), default=""),
        })
    return zones


def main():
    zones = build_zones()
    by = defaultdict(int)
    for z in zones:
        by[(z["spot"], z["level"])] += 1
    print(f"{len(zones)} zones:", dict(by))
    if "--dry-run" in sys.argv:
        for z in zones[:10]:
            print({k: z[k] for k in ("cell_id", "level", "sightings", "raptors", "colony")})
        return

    from dotenv import load_dotenv
    from pymongo import GEOSPHERE, MongoClient
    load_dotenv(HERE / ".env")
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        sys.exit("MONGODB_URI missing from backend/.env")
    col = MongoClient(uri)["nestguard"]["zones"]
    col.delete_many({})                               # reseed from scratch each run
    col.insert_many(zones)
    col.create_index([("loc", GEOSPHERE)])
    col.create_index("cell_id", unique=True)
    print(f"loaded {col.count_documents({})} zones into nestguard.zones with a 2dsphere index")


if __name__ == "__main__":
    main()
