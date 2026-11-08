"""
Live bird zones for places we never seeded, so NestGuard works anywhere.

When /check or /zones finds no zones in Mongo near a spot, we fetch the last 30 days of
eBird + iNaturalist sightings around it, blur them to the same ~1 km grid as seed_zones.py,
upsert them into nestguard.zones and remember the area for ~24 h.

Privacy: exact sighting coordinates are only held in memory while building cells. Only
cell centres are stored, exactly like seed_zones.py.

has_data() tells score_spot whether "no zones here" means "quiet area" (green) or
"we don't know" (a source failed, or neither source has any sightings): unknown.
"""
import datetime
import math
import os
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import requests

import seed_zones as sz          # same grid, sighting parsers and raptor/colony words

TILE_DEG = 0.1                   # cache areas of ~10 km; one fetch covers a whole tile
FETCH_KM = 15                    # tile half-diagonal (~7 km) + safer_spot's 8 km search
OK_TTL_S = 24 * 3600             # good fetches: keep a day
FAIL_TTL_S = 15 * 60             # failed fetches: try again after 15 min
TIMEOUT_S = 3                    # the app gives /zones and /check 4 s before falling back
DAYS_BACK = 30

_tiles = {}                      # (tile_lat, tile_lon) -> {"t", "ok", "n", "zones"}
_locks = defaultdict(threading.Lock)
_locks_guard = threading.Lock()


def tile_of(lat, lon):
    f = lambda v: round((math.floor(v / TILE_DEG) + 0.5) * TILE_DEG, 3)
    return f(lat), f(lon)


def _ebird(lat, lon):
    key = os.environ.get("EBIRD_KEY", "")
    if not key:
        raise RuntimeError("EBIRD_KEY not set")
    r = requests.get("https://api.ebird.org/v2/data/obs/geo/recent",
                     headers={"X-eBirdApiToken": key},
                     params={"lat": lat, "lng": lon, "dist": FETCH_KM, "back": DAYS_BACK},
                     timeout=TIMEOUT_S)
    r.raise_for_status()
    return list(sz.ebird_sightings(r.json(), "live"))


def _inat(lat, lon):
    d1 = (datetime.date.today() - datetime.timedelta(days=DAYS_BACK)).isoformat()
    r = requests.get("https://api.inaturalist.org/v1/observations",
                     params={"lat": lat, "lng": lon, "radius": FETCH_KM, "iconic_taxa": "Aves",
                             "per_page": 200, "order_by": "observed_on", "quality_grade": "research",
                             "d1": d1},
                     headers={"User-Agent": "NestGuard (HackRPI 2026)"},
                     timeout=TIMEOUT_S)
    r.raise_for_status()
    return list(sz.inat_sightings(r.json(), "live"))


def build(sightings):
    """Same cell rules as seed_zones.build_zones()."""
    cells = defaultdict(list)
    for s in sightings:
        cells[sz.snap(s["lat"], s["lon"])].append(s)
    zones = []
    for (lat, lon), group in cells.items():
        names = sorted({g["name"] for g in group if g["name"]})
        low = [n.lower() for n in names]
        raptors = any(w in n for n in low for w in sz.RAPTOR_WORDS)
        colony = any(w in n for n in low for w in sz.COLONY_WORDS)
        n = len(group)
        level = "red" if (raptors or colony or n >= 15) else "yellow" if n >= 3 else "green"
        if level == "green":
            continue
        zones.append({"cell_id": f"live:{lat}:{lon}", "spot": "live", "lat": lat, "lon": lon,
                      "loc": {"type": "Point", "coordinates": [lon, lat]}, "radius_m": 500,
                      "level": level, "sightings": n, "raptors": raptors, "colony": colony,
                      "species": names[:15], "latest": max((g["date"] for g in group), default="")})
    return zones


def _fetch(tile, collection):
    sightings, ok = [], True
    with ThreadPoolExecutor(2) as pool:
        jobs = {name: pool.submit(fn, *tile) for name, fn in (("eBird", _ebird), ("iNaturalist", _inat))}
        for name, job in jobs.items():
            try:
                sightings += job.result()
            except Exception as e:
                ok = False
                print(f"live zones: {name} failed for {tile}: {e}")
    zones = build(sightings)
    if collection is not None and zones:
        try:
            from pymongo import UpdateOne
            now = datetime.datetime.utcnow()
            collection.bulk_write([UpdateOne({"cell_id": z["cell_id"]}, {"$set": dict(z, live_at=now)},
                                             upsert=True) for z in zones], ordered=False)
        except Exception as e:
            print("live zones: Mongo upsert failed:", e)
    print(f"live zones: {tile} ok={ok} sightings={len(sightings)} zones={len(zones)}")
    for z in zones:
        z.pop("_id", None)
    return {"t": time.time(), "ok": ok, "n": len(sightings), "zones": zones}


def ensure(lat, lon, collection=None):
    """Fetch this spot's tile if it isn't cached (or the cache expired). Returns the tile entry."""
    tile = tile_of(lat, lon)
    with _locks_guard:
        lock = _locks[tile]
    with lock:                                   # one fetch per tile, even with parallel requests
        e = _tiles.get(tile)
        if e is None or time.time() - e["t"] > (OK_TTL_S if e["ok"] else FAIL_TTL_S):
            e = _tiles[tile] = _fetch(tile, collection)
        return e


def zones_near(lat, lon, radius_km, collection=None):
    e = ensure(lat, lon, collection)
    return [z for z in e["zones"] if sz_dist(lat, lon, z["lat"], z["lon"]) <= radius_km * 1000]


def has_data(lat, lon):
    """True when this spot's area was fetched from every source and has some sightings."""
    e = _tiles.get(tile_of(lat, lon))
    return bool(e and e["ok"] and e["n"] > 0)


def sz_dist(a, b, c, d):
    p1, p2 = math.radians(a), math.radians(c)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(d - b) / 2) ** 2
    return 12742000 * math.asin(math.sqrt(h))
