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
import live_zones
import scoring
import tiger
import weather

app = FastAPI(title="NestGuard API")

if tiger.enabled():                     # Tiger Data hypertables (time series); optional
    import threading
    threading.Thread(target=lambda: print("Tiger Data ready" if tiger.setup() else "Tiger Data unavailable"),
                     daemon=True).start()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

try:                                    # Fish Audio spoken alerts (Shravan's backend/speak.py)
    from speak import router as speak_router
    app.include_router(speak_router)
except ImportError as e:
    print("speak.py not found, /speak disabled:", e)

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
            found = list(ZONES.find(query, PUBLIC_FIELDS).limit(200))
            if found:
                return found
            # nothing seeded here: fetch live eBird + iNaturalist once (cached ~24 h)
            return live_zones.zones_near(lat, lon, radius_km, ZONES)
        except Exception as e:
            print("zone query failed, using mock:", e)
    mock = [z for z in MOCK_ZONES if dist_m(lat, lon, z["lat"], z["lon"]) <= radius_km * 1000]
    return mock or live_zones.zones_near(lat, lon, radius_km)


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


def best_time(lat, lon, date, base_risk, nesting_until, floor="green"):
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
        rated.append((when, max(lvl, w_min, floor, key=lambda l: RANK[l])))   # floor = hazards that last all day
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
        return f"Lowest risk: {window}"
    if best == 2:
        if nesting_until and scoring.level_for(round(base_risk * 100)) == "red":
            return f"High risk all day: nesting season here until the end of {nesting_until}"
        return "High risk all day today and tomorrow"
    return f"Lowest risk (medium): {window}"


DIRECTIONS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]


def safer_spot(lat, lon, date, level, area_min, area_points=0):
    """Nearest nearby spot (0.5-3 km, 8 directions) in a lower risk band. area_min = the band of
    hazards that cover the whole area (weather, migration, air): moving 3 km can't beat those.
    area_points = their score points, so the spot's risk score is comparable to this one's."""
    if level == "green" or RANK[area_min] >= RANK[level]:
        return None                                    # moving won't fix area-wide hazards
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
            raptor_lvl = ("red" if "nesting season" in r["raptor_alert"] else "yellow") if r["raptor_alert"] else "green"
            cand_level = max(r["level"], raptor_lvl, area_min, key=lambda l: RANK[l])
            cand_score = clamp(r["score"] + POINTS.get(raptor_lvl, 0) + area_points, cand_level)
            if RANK[cand_level] < RANK[level] and (best is None or RANK[cand_level] < best["_band"]
                                                   or (RANK[cand_level] == best["_band"]
                                                       and cand_score < best["score"]
                                                       and km == best["distance_km"])):
                best = {"lat": round(clat, 3), "lon": round(clon, 3), "distance_km": km,
                        "direction": name, "score": cand_score, "_band": RANK[cand_level],
                        "label": f"{km:g} km {name}: risk {cand_score}"}
        if best and best["_band"] == 0:
            break                                      # nearest low-risk spot found; don't look farther
    if best:
        best.pop("_band")
    return best


def clamp(score, level):
    """Keep the score inside its band, so the number always agrees with the worst hazard."""
    lo, hi = {"red": (60, 100), "yellow": (30, 59), "green": (0, 29)}[level]
    return max(lo, min(hi, score))


POINTS = {"yellow": 15, "red": 40}          # extra score points per non-bird hazard
# tie-break when two hazards are equally bad: the more immediate danger first (same as the app)
ORDER = ["powerlines", "raptors", "wind", "clouds", "visibility", "rain", "nesting", "crowd", "migration", "air"]
MOCK_RISK = {"red": 82, "yellow": 55, "green": 12}


def public_mock(z):
    return {"lat": z["lat"], "lon": z["lon"], "radius_m": z["radius_m"], "risk": MOCK_RISK.get(z["level"], 55)}


def score_spot(lat, lon, date, explain_it=False):
    zones = get_zones(lat, lon, 5)
    # no zones AND no complete bird data for this area -> birds are "unknown", not green
    birds_unknown = not zones and not live_zones.has_data(lat, lon)
    w = weather.conditions(lat, lon, date)
    eggs = scoring.nesting_nearby(lat, lon, date, zones) if is_real(zones) else True
    mult, w_reasons, w_min, checks = weather.assess(w, egg_season=eggs)                  # U5/U6
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
    if birds_unknown:
        for h in hazards:
            if h["type"] in ("nesting", "raptors", "migration"):
                h["level"], h["detail"] = "unknown", "No bird data here"
        checks["wildlife"] = "unknown"
        out["reasons"] = ["No bird data for this area"] + out["reasons"]
    known = [h for h in hazards if h["level"] in RANK]
    worst = max(known, key=lambda h: RANK[h["level"]],
                default={"type": "none", "level": "yellow"})   # every source down: be careful
    level = worst["level"]

    # ---- score: bird risk + points for every other hazard, kept consistent with the level
    score = clamp(bird_score + sum(POINTS.get(h["level"], 0) for h in known if h["type"] != "nesting"), level)

    # ---- reasons + message
    extra = [h["detail"] for h in sorted(known, key=lambda h: -RANK[h["level"]])
             if h["level"] != "green" and h["type"] not in ("nesting",) and h["detail"] not in out["reasons"]]
    out["reasons"] = extra + [r for r in out["reasons"] if r not in extra]
    # message = the score and its main driver, as a fact (no Go / Wait / Don't fly verdict)
    drivers = sorted((h for h in known if h["level"] != "green"),
                     key=lambda h: (-RANK[h["level"]], ORDER.index(h["type"]) if h["type"] in ORDER else 99))
    if drivers:
        out["message"] = f"Risk {score}/100: {drivers[0]['detail']}"
    elif birds_unknown:
        out["message"] = f"Risk {score}/100: no bird data here"
    elif not known:
        out["message"] = f"Risk {score}/100: no data for this area right now"
    else:
        out["message"] = f"Risk {score}/100: no hazards found"
    out.pop("level", None)                        # risk score only: no overall level / verdict
    out["score"], out["bird_score"] = score, (None if birds_unknown else bird_score)
    out["hazards"] = hazards                      # each row keeps a green/yellow/red/unknown dot
    if not is_real(zones):
        out["zones"] = [public_mock(z) for z in zones]
    try:
        # only when the birds decide it: moving 2 km can't fix weather, and lines are mapped separately
        area_min = max([w_min] + [h["level"] for h in known if h["type"] in ("migration", "air", "wind",
                                                                         "rain", "visibility", "clouds")],
                       key=lambda l: RANK[l])
        decided_locally = all(h["type"] in ("nesting", "raptors") for h in known if h["level"] == level)
        area_points = sum(POINTS.get(h["level"], 0) for h in known
                          if h["type"] in ("migration", "air", "wind", "rain", "visibility", "clouds"))
        out["safer_spot"] = (safer_spot(lat, lon, date, level, area_min, area_points)
                             if decided_locally else None)
    except Exception as e:
        print("safer_spot failed:", e)
        out["safer_spot"] = None
    try:
        lasting = max(["green"] + [h["level"] for h in known
                                   if h["type"] in ("raptors", "powerlines", "crowd", "migration", "air")],
                      key=lambda l: RANK[l])
        out["best_time"] = best_time(lat, lon, date, out.pop("base_risk"), out.pop("nesting_until"), lasting)
    except Exception as e:
        print("best_time failed:", e)
        out["best_time"] = None
    out.pop("base_risk", None)
    out.pop("nesting_until", None)
    if trend and trend.get("before", 0) < 10:
        trend = dict(trend, ratio=None)           # no real baseline (eBird gives 30 days): no ratio
    out["trend"] = trend                          # Tiger Data: weekly sightings near here
    if explain_it:
        out["why"] = explain.why(out)             # U9: Gemini, only when the app asks
        if tiger.enabled():
            tiger.log_check(*snap(lat, lon), level, out["score"])   # blurred, app checks only
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
    lines = hz.powerlines(lat, lon, min(radius_km, 3))     # map: up to 3 km (hazard check stays 1 km)
    if lines is None:
        raise HTTPException(status_code=503, detail="Power line data unavailable right now")
    return lines


@app.get("/zones")
def zones(lat: float, lon: float, radius_km: float = 5,
          date: datetime.date = Query(default_factory=datetime.date.today)):
    found = get_zones(lat, lon, radius_km)
    if is_real(found):
        return [scoring.public_zone(z, date) for z in found]   # risk for that date, no species
    return [public_mock(z) for z in found]


@app.get("/check")
def check(lat: float, lon: float, date: datetime.date = Query(default_factory=datetime.date.today),
          explain: bool = False):
    """explain=true adds a Gemini "why" sentence (the app uses it; the device doesn't).
    An app check (explain=true) also becomes the device's location, so the device shows the
    spot the user just checked. The device's own checks never set explain, so no loop."""
    if explain:
        device["demo"] = {"lat": lat, "lon": lon, "date": date.isoformat(), "from": "app"}
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
    """Pre-flight checks per hour with their average and highest risk score (Tiger Data)."""
    return tiger.check_stats(hours)


@app.get("/device/telemetry")
def get_telemetry():
    return device["telemetry"]
