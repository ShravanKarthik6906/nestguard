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
import hazards as hz
import scoring
import tiger
import weather

app = FastAPI(title="NestGuard API")

if tiger.enabled():                     # Tiger Data hypertables (time series); optional
    import threading
    threading.Thread(target=lambda: print("Tiger Data ready" if tiger.setup() else "Tiger Data unavailable"),
                     daemon=True).start()
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
    """U9: today -> scan from now to the end of tomorrow and report the first daylight window
    with the best level; other dates -> that day's daylight hours."""
    local_today = weather.local_now(lat, lon)
    if date == local_today.date():
        start = local_today.replace(minute=0, second=0, microsecond=0)
        hs = weather.hours(lat, lon, date) + weather.hours(lat, lon, date + datetime.timedelta(days=1))
        hs = [h for h in hs if h[0] >= start]
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
    end = run[-1] + datetime.timedelta(hours=1)
    daylight = {when for when, _ in rated}
    b = hour_label(end, local_today.date())[1] if end in daylight else "sunset"
    window = f"{day} {a} to {b}"
    if run[0] <= local_today < end:
        window = f"Now until {b}"
    if best == 0:
        return window
    if best == 2:
        if nesting_until and scoring.level_for(round(base_risk * 100)) == "red":
            return f"No safe window: nesting season here until the end of {nesting_until}"
        return "No safe window today or tomorrow"
    return f"No clear window; least risky {window}"


DIRECTIONS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]


def safer_spot(lat, lon, date, level, weather_min):
    """Nearest nearby spot (0.5-3 km, 8 directions) with a better wildlife level, using the same
    weather (it is the same area). None when it's already Go, or when the weather is the problem."""
    if level == "green" or RANK[weather_min] >= RANK[level]:
        return None                                    # moving won't fix the weather
    zones = get_zones(lat, lon, 8)
    if not is_real(zones):
        return None
    best = None
    for km in (0.5, 1, 1.5, 2, 3):
        for i, name in enumerate(DIRECTIONS):
            ang = math.radians(45 * i)
            clat = lat + km / 111.0 * math.cos(ang)
            clon = lon + km / (111.0 * math.cos(math.radians(lat))) * math.sin(ang)
            r = scoring.score(clat, clon, date, zones)
            cand_level = max(r["level"], weather_min, key=lambda l: RANK[l])
            if RANK[cand_level] < RANK[level] and (best is None or RANK[cand_level] < RANK[best["level"]]
                                                   or (cand_level == best["level"] and r["score"] < best["score"]
                                                       and km == best["distance_km"])):
                best = {"lat": round(clat, 3), "lon": round(clon, 3), "distance_km": km,
                        "direction": name, "level": cand_level, "score": r["score"],
                        "label": f"{km:g} km {name}: {scoring.LABEL_WORD[cand_level]}"}
        if best and best["level"] == "green":
            break                                      # nearest Go found; don't look farther
    return best


POINTS = {"yellow": 15, "red": 40}          # extra score points per non-bird hazard
HAZARD_MESSAGE = {
    "powerlines": {"red": "Don't fly: power line too close, move at least 100 m away",
                   "yellow": "Wait: power line nearby, stay low and keep it in sight"},
    "crowd": {"yellow": "Wait: dense area with people below"},
    "migration": {"yellow": "Wait: migration season, watch for flocks"},
    "air": {"yellow": "Wait: smoky air, low visibility"},
    "raptors": {"red": "Don't fly: hawks or eagles nesting nearby may attack",
                "yellow": "Wait: hawks or eagles nearby, watch the sky"},
}


def score_spot(lat, lon, date, explain_it=False):
    zones = get_zones(lat, lon, 5)
    w = weather.conditions(lat, lon, date)
    mult, w_reasons, w_min, checks = weather.assess(w)                                   # U5/U6
    trend = tiger.trend(lat, lon, date) if tiger.enabled() else None                    # Tiger Data
    trend_reason = []
    # only claim a rise when the earlier weeks have a real baseline (eBird gives us 30 days)
    if trend and trend["ratio"] and trend["ratio"] >= 2 and trend["recent"] >= 5 and trend["before"] >= 10:
        mult *= 1.15
        trend_reason = [f"Sightings up {trend['ratio']:g}x in the last 2 weeks"]
    near_n = sum(z.get("sightings", 0) for z in zones
                 if dist_m(lat, lon, z["lat"], z["lon"]) <= 2000 + z.get("radius_m", 500))
    other, mig_mult = hz.assess(lat, lon, date, near_n)                                 # new hazards
    mult *= mig_mult
    if is_real(zones):
        out = scoring.score(lat, lon, date, zones, weather_mult=mult,
                            weather_reasons=trend_reason + w_reasons)
    else:
        out = mock_score(lat, lon, zones)
        out.update(raptor_alert=None, nesting_until=None, base_risk=out["score"] / 100)
        out["reasons"] += w_reasons
    bird_level, bird_score = out["level"], out["score"]
    checks["wildlife"] = bird_level

    # ---- the hazard breakdown (overall level = the worst hazard)
    raptor = out.get("raptor_alert")
    season = next((r for r in out["reasons"] if "season" in r.lower()), "")
    if bird_level == "green":
        nest_detail = season or f"Bird risk {bird_score}/100"
    elif season.startswith("Outside"):
        nest_detail = f"Outside nesting season, but busy: bird risk {bird_score}/100"
    else:
        nest_detail = season or f"Bird risk {bird_score}/100"
    hazards = [{"type": "nesting", "level": bird_level, "detail": nest_detail},
               {"type": "raptors",
                "level": ("red" if raptor and "nesting season" in raptor else "yellow") if raptor else "green",
                "detail": "Hawk or eagle sightings within 1 km" if raptor else "No hawks or eagles seen nearby"}]
    hazards += other + weather.hazards(w)
    known = [h for h in hazards if h["level"] in RANK]
    worst = max(known, key=lambda h: RANK[h["level"]])
    level = worst["level"]

    # ---- score: bird risk + points for every other hazard, kept consistent with the level
    score = bird_score + sum(POINTS.get(h["level"], 0) for h in known if h["type"] not in ("nesting",))
    score = min(100, max(score, {"red": 60, "yellow": 30, "green": 0}[level]))
    if level == "green":
        score = min(score, 29)

    # ---- reasons + message
    extra = [h["detail"] for h in sorted(known, key=lambda h: -RANK[h["level"]])
             if h["level"] != "green" and h["type"] not in ("nesting",) and h["detail"] not in out["reasons"]]
    out["reasons"] = extra + [r for r in out["reasons"] if r not in extra]
    if RANK[level] > RANK[bird_level]:
        if worst["type"] in HAZARD_MESSAGE and level in HAZARD_MESSAGE[worst["type"]]:
            out["message"] = HAZARD_MESSAGE[worst["type"]][level]
        elif level == "red":
            out["message"] = "Don't fly: below FAA weather minimums"
        else:
            out["message"] = "Wait: too windy or wet to fly safely"
    out["level"], out["score"], out["bird_score"] = level, score, bird_score
    out["hazards"] = hazards
    out["checks"] = checks                        # {"wildlife", "safety", "legal"} (kept for the UI)
    try:
        # only when the birds decide it: moving 2 km can't fix weather, and lines are mapped separately
        out["safer_spot"] = safer_spot(lat, lon, date, bird_level, w_min) if bird_level == level else None
    except Exception as e:
        print("safer_spot failed:", e)
        out["safer_spot"] = None
    try:
        out["best_time"] = best_time(lat, lon, date, out.pop("base_risk"), out.pop("nesting_until"))
    except Exception as e:
        print("best_time failed:", e)
        out["best_time"] = None
    out.pop("base_risk", None)
    out.pop("nesting_until", None)
    out["trend"] = trend                          # Tiger Data: weekly sightings near here
    if explain_it:
        out["why"] = explain.why(out)             # U9: Gemini, only when the app asks
        if tiger.enabled():
            tiger.log_check(*snap(lat, lon), out["level"], out["score"])   # blurred, app checks only
    return out


@app.get("/debug/overpass")
def debug_overpass():
    """Why power lines show "unknown": the last Overpass error, and one live test call."""
    hz._overpass_down_until = 0
    test = hz._overpass(42.73, -73.68, 300)
    return {"ok": test is not None, "lines_found": len(test["lines"]) if test else None,
            "last_error": hz._last_error}


@app.get("/powerlines")
def powerlines(lat: float, lon: float, radius_km: float = 1):
    """Power-line polylines near a point (OpenStreetMap; demo areas pre-loaded, others cached).
    503 = data unavailable right now (not the same as "no power lines")."""
    from fastapi import HTTPException
    lines = hz.powerlines(lat, lon, min(radius_km, 1.5))
    if lines is None:
        raise HTTPException(status_code=503, detail="Power line data unavailable right now")
    return lines


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
    if tiger.enabled():
        tiger.log_telemetry(body.get("temp_c"), body.get("light_pct"))   # Tiger Data hypertable
    return {"ok": True}


@app.get("/device/telemetry/history")
def telemetry_history(minutes: int = 60, bucket_s: int = 60):
    """Device readings over time from Tiger Data (time_bucket averages)."""
    return tiger.telemetry_history(minutes, bucket_s)


@app.get("/trend")
def trend(lat: float, lon: float, date: datetime.date = Query(default_factory=datetime.date.today)):
    """Weekly sightings near a point (blurred cells), from Tiger Data."""
    return tiger.trend(lat, lon, date) or {"weekly": [], "recent": 0, "before": 0, "ratio": None}


@app.get("/stats/checks")
def check_stats(hours: int = 24):
    """How many pre-flight checks said Go / Wait / Don't fly per hour (Tiger Data)."""
    return tiger.check_stats(hours)


@app.get("/device/telemetry")
def get_telemetry():
    return device["telemetry"]
