"""
"Will my drone make it back?" hazards beyond birds + weather.

  power lines   OpenStreetMap via Overpass (free, no key). Exact geometry is fine: public infrastructure.
  crowd density OpenStreetMap buildings within 300 m (same Overpass request).
  migration     season (Mar-Jun, Aug-Nov; flipped south of the equator) + nearby sighting count.
  air quality   Open-Meteo air-quality API, US AQI (smoke = low visibility).

Every hazard is fail-safe: if its source is down it is reported as "unknown" and never
changes the answer. Overpass rate-limits, so results are cached per ~500 m cell for 6 hours.
"""
import datetime
import json
import math
import pathlib
import time

import requests

OVERPASS = ["https://overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter",
            "https://overpass.private.coffee/api/interpreter",
            "https://lz4.overpass-api.de/api/interpreter"]
PRELOAD_FILE = pathlib.Path(__file__).parent / "powerlines_preload.json"   # demo areas, committed
AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
UA = {"User-Agent": "NestGuard/1.0 (HackRPI 2026 student project)"}

LINE_RED_M, LINE_YELLOW_M = 100, 300
QUERY_RADIUS_M = 1500           # one query per ~500 m cell covers any point inside it + 1 km
BUILDINGS_YELLOW = 150          # buildings within 300 m
AQI_YELLOW = 150
MIGRATION_MONTHS = (3, 4, 5, 6, 8, 9, 10, 11)
MIGRATION_BUSY = 30             # sightings within 2 km that count as "high bird activity"

CACHE_FILE = pathlib.Path(__file__).parent / ".cache" / "overpass.json"
TTL_S = 6 * 3600
try:
    _cache = json.loads(CACHE_FILE.read_text())
except Exception:
    _cache = {}


def _save():
    try:
        CACHE_FILE.parent.mkdir(exist_ok=True)
        CACHE_FILE.write_text(json.dumps(_cache))
    except Exception:
        pass


# ------------------------------------------------------------------ geometry
def _xy(lat, lon, lat0):
    """Metres east/north of (0,0) using a local flat projection - fine at km scale."""
    return lon * 111320 * math.cos(math.radians(lat0)), lat * 110540


def _dist_to_segment(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def nearest_line_m(lat, lon, lines):
    best = None
    p = _xy(lat, lon, lat)
    for line in lines:
        pts = [_xy(a, b, lat) for a, b in line["coords"]]
        for a, b in zip(pts, pts[1:]):
            d = _dist_to_segment(p, a, b)
            if best is None or d < best:
                best = d
    return best


# ------------------------------------------------------------------ pre-loaded demo areas
try:
    _preload = json.loads(PRELOAD_FILE.read_text())       # [{name, lat, lon, radius_m, lines, buildings}]
except Exception:
    _preload = []


def _from_preload(lat, lon):
    """Lines + building count from a pre-loaded area that fully covers this point, else None."""
    for a in _preload:
        d = math.hypot(*(p - q for p, q in zip(_xy(lat, lon, lat), _xy(a["lat"], a["lon"], lat))))
        if d + 1000 <= a["radius_m"]:                      # the 1 km around the point is inside the area
            me = _xy(lat, lon, lat)
            near = sum(1 for b in a["buildings"] if math.hypot(*(p - q for p, q in zip(me, _xy(b[0], b[1], lat)))) <= 300)
            return {"lines": a["lines"], "buildings": near, "source": f"preloaded ({a['name']})"}
    return None


# ------------------------------------------------------------------ Overpass
_overpass_down_until = 0
_last_error = None


def _overpass(lat, lon, radius_m):
    global _overpass_down_until, _last_error
    if time.time() < _overpass_down_until:
        return None                                   # failed recently: don't slow every check
    q = (f'[out:json][timeout:25];'
         f'(way(around:{radius_m},{lat},{lon})["power"~"^(line|minor_line)$"];)->.p;.p out geom;'
         f'way(around:300,{lat},{lon})["building"];out count;')
    last, started = None, time.time()
    for url in OVERPASS:
        try:
            if time.time() - started > 20:
                break                                     # never hold a /check longer than ~20 s
            r = requests.post(url, data={"data": q}, headers=UA, timeout=8)
            if r.status_code == 429:
                last = "rate limited"
                continue
            if r.status_code >= 500:
                last = f"{url}: HTTP {r.status_code}"
                continue
            r.raise_for_status()
            lines, buildings = [], None
            for el in r.json().get("elements", []):
                if el.get("type") == "way" and el.get("geometry"):
                    lines.append({"coords": [[round(g["lat"], 6), round(g["lon"], 6)] for g in el["geometry"]],
                                  "kind": (el.get("tags") or {}).get("power", "line"),
                                  "voltage": (el.get("tags") or {}).get("voltage")})
                elif el.get("type") == "count":
                    buildings = int((el.get("tags") or {}).get("ways", 0))
            return {"lines": lines, "buildings": buildings, "source": "live"}
        except Exception as e:
            last = f"{url}: {e}"
    print("Overpass unavailable for 2 min:", last)
    _last_error = str(last)[:300]
    _overpass_down_until = time.time() + 120
    return None


def osm_area(lat, lon):
    """Power lines within ~1 km and the building count near this ~500 m cell (cached 6 h)."""
    pre = _from_preload(lat, lon)                                        # demo areas first
    if pre:
        return pre
    clat, clon = round(lat * 200) / 200, round(lon * 200) / 200          # 0.005 deg cell
    key = f"{clat},{clon}"
    hit = _cache.get(key)
    if hit and time.time() - hit["t"] < TTL_S:
        return hit["v"]
    v = _overpass(clat, clon, QUERY_RADIUS_M)
    if v is not None:                                                    # only successes are cached
        # building count is for the cell centre; good enough for "is this a dense area"
        _cache[key] = {"t": time.time(), "v": v}
        _save()
    return v


def powerlines(lat, lon, radius_km=1.0):
    """For the map: power-line polylines within radius_km of the point. None = data unavailable."""
    area = osm_area(lat, lon)
    if not area:
        return None
    r = radius_km * 1000
    return [{"coords": l["coords"], "kind": l["kind"], "voltage": l["voltage"]}
            for l in area["lines"] if (nearest_line_m(lat, lon, [l]) or 1e9) <= r]


# ------------------------------------------------------------------ air quality
def us_aqi(lat, lon, date):
    key = f"aqi:{round(lat, 2)},{round(lon, 2)},{date.isoformat()}"
    hit = _cache.get(key)
    if hit and time.time() - hit["t"] < 3600:
        return hit["v"]
    try:
        r = requests.get(AQ_URL, timeout=8, headers=UA, params={
            "latitude": round(lat, 2), "longitude": round(lon, 2), "hourly": "us_aqi",
            "start_date": date.isoformat(), "end_date": date.isoformat(), "timezone": "auto"})
        r.raise_for_status()
        vals = [v for v in r.json().get("hourly", {}).get("us_aqi", []) if v is not None]
        v = max(vals) if vals else None
    except Exception as e:
        print("Air quality unavailable:", e)
        return None
    _cache[key] = {"t": time.time(), "v": v}
    _save()
    return v


# ------------------------------------------------------------------ the hazard list
def assess(lat, lon, date, nearby_sightings):
    """Returns (hazards list, wildlife multiplier). Each hazard: type, level, detail."""
    out, mult = [], 1.0

    area = osm_area(lat, lon)
    if area is None:
        out.append({"type": "powerlines", "level": "unknown", "detail": "Power line data unavailable"})
        out.append({"type": "crowd", "level": "unknown", "detail": "Building data unavailable"})
    else:
        d = nearest_line_m(lat, lon, area["lines"])
        if d is None or d > 1000:
            out.append({"type": "powerlines", "level": "green", "detail": "No power lines within 1 km"})
        else:
            lvl = "red" if d <= LINE_RED_M else "yellow" if d <= LINE_YELLOW_M else "green"
            out.append({"type": "powerlines", "level": lvl, "detail": f"Power line {round(d / 10) * 10:.0f} m away"})
        b = area["buildings"]
        if b is None:
            out.append({"type": "crowd", "level": "unknown", "detail": "Building data unavailable"})
        elif b >= BUILDINGS_YELLOW:
            out.append({"type": "crowd", "level": "yellow", "detail": f"Dense area: people below ({b} buildings within 300 m)"})
        else:
            out.append({"type": "crowd", "level": "green", "detail": f"{b} buildings within 300 m"})

    month = date.month if lat >= 0 else (date.month + 5) % 12 + 1
    if month in MIGRATION_MONTHS:
        busy = nearby_sightings >= MIGRATION_BUSY
        if busy:
            mult *= 1.2
        out.append({"type": "migration", "level": "yellow",
                    "detail": "Migration season: high bird activity" if busy else "Migration season"})
    else:
        out.append({"type": "migration", "level": "green", "detail": "Outside migration season"})

    aqi = us_aqi(lat, lon, date)
    if aqi is None:
        out.append({"type": "air", "level": "unknown", "detail": "Air quality unavailable"})
    else:
        out.append({"type": "air", "level": "yellow" if aqi > AQI_YELLOW else "green",
                    "detail": f"Air quality index {aqi:.0f}" + (" (smoke, low visibility)" if aqi > AQI_YELLOW else "")})
    return out, mult
