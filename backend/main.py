"""
NestGuard backend - starter (mock first, real later).

Run:
  pip install fastapi uvicorn
  uvicorn main:app --host 0.0.0.0 --port 8000 --reload
Open http://localhost:8000/docs to test every endpoint.

Right now /zones and /check return mock data so Shravan and Ryan can build
against them immediately. Replace the bodies of get_zones() and score_spot()
with the real MongoDB query (U3) and risk score (U4-U6) - keep the response
shapes the same so nobody else has to change anything.
"""
import datetime
import math
import os
import pathlib

from fastapi import Body, FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

import explain
import scoring
import weather

app = FastAPI(title="NestGuard API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

try:                                   # load backend/.env (MONGODB_URI, keys)
    from dotenv import load_dotenv
    load_dotenv(pathlib.Path(__file__).parent / ".env")
except ImportError:
    pass

GRID_DEG = 0.01   # ~1 km grid: zones are snapped to this, never exact nest points (U6)

# --- mock zones (already blurred to grid centres). Replace with MongoDB in U3.
MOCK_ZONES = [
    {"lat": 42.735, "lon": -73.675, "radius_m": 200, "level": "red"},     # near RPI
    {"lat": 42.725, "lon": -73.695, "radius_m": 300, "level": "yellow"},
    {"lat": 33.705, "lon": -118.045, "radius_m": 1000, "level": "red"},   # Bolsa Chica
]


def snap(lat, lon):
    """Blur a point to the centre of its ~1 km grid cell."""
    f = lambda v: round((math.floor(v / GRID_DEG) + 0.5) * GRID_DEG, 4)
    return f(lat), f(lon)


def dist_m(a, b, c, d):
    p1, p2 = math.radians(a), math.radians(c)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(d - b) / 2) ** 2
    return 12742000 * math.asin(math.sqrt(h))


# --- MongoDB Atlas (U3). Falls back to MOCK_ZONES if there is no URI or Atlas is down.
ZONES = None
if os.environ.get("MONGODB_URI"):
    try:
        from pymongo import MongoClient
        _client = MongoClient(os.environ["MONGODB_URI"], serverSelectionTimeoutMS=4000)
        _client.admin.command("ping")
        ZONES = _client["nestguard"]["zones"]
        print("MongoDB Atlas connected")
    except Exception as e:
        print("MongoDB unavailable, using mock zones:", e)

PUBLIC_FIELDS = {"_id": 0, "lat": 1, "lon": 1, "radius_m": 1, "level": 1,
                 "sightings": 1, "raptors": 1, "colony": 1, "species": 1, "latest": 1}


def get_zones(lat, lon, radius_km):
    if ZONES is not None:
        try:
            query = {"sightings": {"$exists": True},      # skip stray test docs
                     "loc": {"$nearSphere": {
                "$geometry": {"type": "Point", "coordinates": [lon, lat]},   # [lon, lat]!
                "$maxDistance": radius_km * 1000}}}
            return list(ZONES.find(query, PUBLIC_FIELDS).limit(200))
        except Exception as e:
            print("zone query failed, using mock:", e)
    return [z for z in MOCK_ZONES if dist_m(lat, lon, z["lat"], z["lon"]) <= radius_km * 1000]


def mock_score(lat, lon, zones):
    d = lambda z: dist_m(lat, lon, z["lat"], z["lon"])
    inside = [z for z in zones if d(z) <= z["radius_m"]]
    near = [z for z in zones if d(z) <= z["radius_m"] + 300]
    if any(z["level"] == "red" for z in inside):
        out = {"level": "red", "score": 82, "message": "Nesting zone, climb to 300 ft",
               "reasons": ["Hawk sightings within 1 km", "Nesting season"]}
    elif inside or near:
        out = {"level": "yellow", "score": 55, "message": "Birds nearby, keep 100 m away",
               "reasons": ["Recent sightings nearby"]}
    else:
        out = {"level": "green", "score": 12, "message": "Clear to fly", "reasons": []}
    out["zones"] = zones
    return out


def is_real(zones):
    return bool(zones) and "sightings" in zones[0]


RANK = {"green": 0, "yellow": 1, "red": 2}


def hour_label(when, today):
    day = ("Today" if when.date() == today else
           "Tomorrow" if (when.date() - today).days == 1 else when.strftime("%b %d").replace(" 0", " "))
    return day, when.strftime("%I %p").lstrip("0")


def best_time(lat, lon, date, base_risk, nesting_until):
    """U9: scan the next 12 daylight hours (today) or that day's daylight hours (other dates)."""
    local_today = weather.local_now(lat, lon)
    if date == local_today.date():
        start = local_today.replace(minute=0, second=0, microsecond=0)
        hs = weather.hours(lat, lon, date) + weather.hours(lat, lon, date + datetime.timedelta(days=1))
        hs = [h for h in hs if start <= h[0] < start + datetime.timedelta(hours=12)]
    else:
        hs = weather.hours(lat, lon, date)
    hs = [h for h in hs if h[2]]                       # daylight only
    if not hs:
        return None
    rated = []
    for when, w, _ in hs:
        mult, _, w_min, _ = weather.assess(w)
        lvl = scoring.level_for(round(min(1.0, base_risk * mult) * 100))
        rated.append((when, max(lvl, w_min, key=lambda l: RANK[l])))
    best = min(RANK[l] for _, l in rated)
    # first run of consecutive hours at the best level
    run = []
    for when, lvl in rated:
        if RANK[lvl] == best and (not run or when - run[-1] == datetime.timedelta(hours=1)):
            run.append(when)
        elif run:
            break
    day, a = hour_label(run[0], local_today.date())
    _, b = hour_label(run[-1] + datetime.timedelta(hours=1), local_today.date())
    window = f"{day} {a} to {b}"
    if best == 0:
        return window
    if best == 2:
        if nesting_until and scoring.level_for(round(base_risk * 100)) == "red":
            return f"No safe window: nesting season here until the end of {nesting_until}"
        return "No safe window in the next 12 hours"
    return f"No clear window; least risky {window}"


def score_spot(lat, lon, date, explain_it=False):
    zones = get_zones(lat, lon, 5)
    mult, w_reasons, w_min, checks = weather.assess(weather.conditions(lat, lon, date))  # U5/U6
    if is_real(zones):
        out = scoring.score(lat, lon, date, zones, weather_mult=mult, weather_reasons=w_reasons)
    else:
        out = mock_score(lat, lon, zones)
        out["reasons"] += w_reasons
        out.update(raptor_alert=None, nesting_until=None, base_risk=out["score"] / 100)
    checks["wildlife"] = out["level"]
    if RANK[w_min] > RANK[out["level"]]:          # weather can make it stricter, never looser
        out["level"] = w_min
        out["message"] = ("Don't fly: below FAA weather minimums" if w_min == "red"
                          else "Wait: too windy or wet to fly safely")
        # put the weather reasons that decided it first
        out["reasons"] = w_reasons + [r for r in out["reasons"] if r not in w_reasons]
    out["checks"] = checks                        # {"wildlife", "safety", "legal"}
    try:
        out["best_time"] = best_time(lat, lon, date, out.pop("base_risk"), out.pop("nesting_until"))
    except Exception as e:
        print("best_time failed:", e)
        out["best_time"] = None
    out.pop("base_risk", None)
    out.pop("nesting_until", None)
    if explain_it:
        out["why"] = explain.why(out)             # U9: Gemini, only when the app asks
    return out


@app.get("/zones")
def zones(lat: float, lon: float, radius_km: float = 5,
          date: datetime.date = Query(default_factory=datetime.date.today)):
    found = get_zones(lat, lon, radius_km)
    if is_real(found):
        return [scoring.public_zone(z, date) for z in found]   # level for that date, no species
    return found


@app.get("/check")
def check(lat: float, lon: float, date: datetime.date = Query(default_factory=datetime.date.today),
          explain: bool = False):
    """explain=true adds a Gemini "why" sentence (the app uses it; the device doesn't)."""
    return score_spot(lat, lon, date, explain_it=explain)


# --- device routes (the Pi polls these)
device = {"demo": {}, "telemetry": {}}


@app.get("/device/demo")
def get_demo():
    return device["demo"]


@app.post("/device/demo")
def set_demo(body: dict = Body(...)):
    device["demo"] = body
    return {"ok": True, "demo": body}


@app.post("/device/telemetry")
def post_telemetry(body: dict = Body(...)):
    device["telemetry"] = body
    return {"ok": True}


@app.get("/device/telemetry")
def get_telemetry():
    return device["telemetry"]
