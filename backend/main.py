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
            query = {"loc": {"$nearSphere": {
                "$geometry": {"type": "Point", "coordinates": [lon, lat]},   # [lon, lat]!
                "$maxDistance": radius_km * 1000}}}
            return list(ZONES.find(query, PUBLIC_FIELDS).limit(200))
        except Exception as e:
            print("zone query failed, using mock:", e)
    return [z for z in MOCK_ZONES if dist_m(lat, lon, z["lat"], z["lon"]) <= radius_km * 1000]


def score_spot(lat, lon, date):
    # U4-U6: replace with the real score (sightings, season, weather, safety, legal).
    zones = get_zones(lat, lon, 5)
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
    out["best_time"] = None            # U9: e.g. "Tomorrow 10 AM to 1 PM"
    return out


@app.get("/zones")
def zones(lat: float, lon: float, radius_km: float = 5):
    return get_zones(lat, lon, radius_km)


@app.get("/check")
def check(lat: float, lon: float, date: datetime.date = Query(default_factory=datetime.date.today)):
    return score_spot(lat, lon, date)


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
