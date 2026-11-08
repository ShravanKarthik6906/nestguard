"""
KnowFlyZone backend - starter (mock first, real later).

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
import time

from typing import Optional

from fastapi import Body, FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

import explain
import hazards as hz
import live_zones
import scoring
import tiger
import weather

app = FastAPI(title="KnowFlyZone API")

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


def best_time(lat, lon, date, base_risk, nesting_until, floor="green", height_ft=weather.DEFAULT_HEIGHT_FT):
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
        mult, _, w_min, _ = weather.assess(w, height_ft=height_ft)
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


AREA_TYPES = ("wind", "rain", "clouds", "visibility", "air")      # same for every spot within 3 km


def near_sightings(lat, lon, zones):
    return sum(z.get("sightings", 0) for z in zones
               if dist_m(lat, lon, z["lat"], z["lon"]) <= 2000 + z.get("radius_m", 500))


def safer_spot(lat, lon, date, here_score, level, area, base_mult, here_local_known, min_drop=3, max_local_checks=12, budget_s=8):
    """The nearest spot within 3 km (8 directions, 0.5-3 km) with a lower risk score, scored the
    same way as this spot: birds and hawks there, migration from the sightings there, the same
    weather and air (`area`), and power lines and buildings there.
    Preference: a spot in a lower band (nearest first); otherwise the nearest spot at least
    `min_drop` points lower. Power lines/buildings need a map lookup, so only the most promising
    `max_local_checks` candidates get one, within `budget_s` seconds (cached map lookups are instant).
    None when nothing nearby is lower."""
    if level == "green" and here_score <= 10:
        return None                                    # already about as low as it gets
    zones = get_zones(lat, lon, 8)
    if not is_real(zones):
        return None
    area_pts = sum(points(h) for h in area)
    area_lvls = [h["level"] for h in area]
    cands = []
    for km in (0.5, 1, 1.5, 2, 3):
        for i, name in enumerate(DIRECTIONS):
            ang = math.radians(45 * i)
            clat = lat + km / 111.0 * math.cos(ang)
            clon = lon + km / (111.0 * math.cos(math.radians(lat))) * math.sin(ang)
            mig, mig_mult = hz.migration(clat, date, near_sightings(clat, clon, zones))
            r = scoring.score(clat, clon, date, zones, weather_mult=base_mult * mig_mult)
            raptor = {"level": ("red" if "nesting season" in r["raptor_alert"] else "yellow") if r["raptor_alert"] else "green"}
            hz_c = [raptor, mig]
            lvl = max([r["level"]] + [h["level"] for h in hz_c] + area_lvls, key=lambda l: RANK[l])
            raw = r["score"] + sum(points(h) for h in hz_c) + area_pts
            cands.append({"lat": clat, "lon": clon, "km": km, "dir": name, "raw": raw, "lvl": lvl, "hz": hz_c,
                          "score": clamp(raw, lvl)})
    # promising first: lower band, then nearest, then lowest; local points can only add, so a
    # candidate that is not lower before the lookup can't become lower after it
    # check the best 3 at every distance before the rest, so a dense block nearby doesn't use up
    # all the lookups
    pool = [c for c in cands if c["score"] <= here_score - min_drop]
    for km in {c["km"] for c in pool}:
        for i, c in enumerate(sorted((c for c in pool if c["km"] == km), key=lambda c: c["score"])):
            c["ring_rank"] = i
    pool.sort(key=lambda c: (RANK[c["lvl"]], c["ring_rank"] >= 3, c["km"], c["score"]))
    t0 = time.time()
    for c in pool[:max_local_checks]:
        if time.time() - t0 > budget_s:
            break
        loc = hz.local(c["lat"], c["lon"])
        if loc is None:
            if here_local_known:
                continue                               # can't check power lines there: don't suggest it
            loc = []
        if any(h["type"] == "powerlines" and h["level"] != "green" for h in loc):
            continue                                   # never send someone next to a power line
        known = [h for h in loc if h["level"] in RANK]
        lvl = max([c["lvl"]] + [h["level"] for h in known], key=lambda l: RANK[l])
        score = clamp(c["raw"] + sum(points(h) for h in known), lvl)
        if score > here_score - min_drop:
            continue
        spot = {"lat": round(c["lat"], 4), "lon": round(c["lon"], 4), "distance_km": c["km"], "direction": c["dir"],
                "score": score, "label": f"{c['km']:g} km {c['dir']}: risk {score}"}
        if RANK[lvl] >= RANK[level] and level != "green":
            spot["note"] = "Lower risk, but the hazards that cover the whole area (like migration or weather) still apply there."
        if loc == []:
            spot["note"] = (spot.get("note", "") + " Power lines there could not be checked.").strip()
        return spot
    return None


def clamp(score, level):
    """Fit a raw score into its band, so the number always agrees with the worst hazard.
    The raw score is spread over the band instead of being pinned to its floor: x = raw points
    above the band's own base (one yellow hazard = 15, one red = 40), and x / (x + k) eases towards
    the band's top without hitting it, so busy and very busy spots still get different numbers.
    Monotonic within a band; green is unchanged up to its top."""
    lo, hi = BANDS[level]
    if level == "green":
        return int(round(min(hi, max(lo, score))))
    base, k = {"yellow": (POINTS["yellow"], 25), "red": (POINTS["red"], 40)}[level]
    x = max(0.0, score - base)
    return int(round(lo + (hi - lo) * x / (x + k)))


BANDS = {"red": (60, 100), "yellow": (30, 59), "green": (0, 29)}
POINTS = {"yellow": 15, "red": 40}          # extra score points per non-bird hazard
GRADE = {"green": 4, "yellow": 15, "red": 20}   # extra points by how severe it is within its level


def points(h):
    """Score points for one hazard: its level, plus a graded part from the measurement behind it
    (distance to a power line, gust speed, sightings nearby...). "sev" is 0-1 within the level;
    hazards without one count as the middle of their level."""
    if h["level"] not in GRADE:
        return 0
    sev = min(1.0, max(0.0, h.get("sev", 0.5 if h["level"] != "green" else 0)))
    return POINTS.get(h["level"], 0) + GRADE[h["level"]] * sev
# tie-break when two hazards are equally bad: the more immediate danger first (same as the app)
ORDER = ["powerlines", "raptors", "wind", "clouds", "visibility", "rain", "nesting", "crowd", "migration", "air"]
MOCK_RISK = {"red": 82, "yellow": 55, "green": 12}


def public_mock(z):
    return {"lat": z["lat"], "lon": z["lon"], "radius_m": z["radius_m"], "risk": MOCK_RISK.get(z["level"], 55)}


def score_spot(lat, lon, date, explain_it=False, height_ft=weather.DEFAULT_HEIGHT_FT):
    zones = get_zones(lat, lon, 5)
    # no zones AND no complete bird data for this area -> birds are "unknown", not green
    birds_unknown = not zones and not live_zones.has_data(lat, lon)
    w = weather.conditions(lat, lon, date)
    eggs = scoring.nesting_nearby(lat, lon, date, zones) if is_real(zones) else True
    mult, w_reasons, w_min, checks = weather.assess(w, egg_season=eggs, height_ft=height_ft)  # U5/U6
    trend = tiger.trend(lat, lon, date) if tiger.enabled() else None                    # Tiger Data
    trend_reason = []
    # only claim a rise when the earlier weeks have a real baseline (eBird gives us 30 days)
    if trend and trend["ratio"] and trend["ratio"] >= 2 and trend["recent"] >= 5 and trend["before"] >= 10:
        mult *= 1.15
        trend_reason = [f"Sightings up {trend['ratio']:g}x in the last 2 weeks"]
    near_n = near_sightings(lat, lon, zones)
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
    hazards += other + weather.hazards(w, height_ft)
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
    score = clamp(bird_score + sum(points(h) for h in known if h["type"] != "nesting"), level)

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
    out["hazards"] = [{k: v for k, v in h.items() if k != "sev"} for h in hazards]   # sev is internal
    if not is_real(zones):
        out["zones"] = [public_mock(z) for z in zones]
    try:
        area = [h for h in known if h["type"] in AREA_TYPES]
        here_local_known = any(h["type"] == "powerlines" and h["level"] in RANK for h in hazards)
        out["safer_spot"] = (safer_spot(lat, lon, date, score, level, area, mult / mig_mult, here_local_known)
                             if not birds_unknown else None)
    except Exception as e:
        print("safer_spot failed:", e)
        out["safer_spot"] = None
    try:
        lasting = max(["green"] + [h["level"] for h in known
                                   if h["type"] in ("raptors", "powerlines", "crowd", "migration", "air")],
                      key=lambda l: RANK[l])
        out["best_time"] = best_time(lat, lon, date, out.pop("base_risk"), out.pop("nesting_until"), lasting, height_ft)
    except Exception as e:
        print("best_time failed:", e)
        out["best_time"] = None
    out.pop("base_risk", None)
    out.pop("nesting_until", None)
    if trend and trend.get("before", 0) < 10:
        trend = dict(trend, ratio=None)           # no real baseline (eBird gives 30 days): no ratio
    out["trend"] = trend                          # Tiger Data: weekly sightings near here
    out["height_ft"] = height_ft                  # planned flight height the clouds were checked against
    if explain_it:
        out["why"] = explain.why(out)             # U9: Gemini, only when the app asks
    return out


# --- check cache: a result is reused for 30 min (today/future: weather moves) or 24 h (past
# dates), in memory and in MongoDB (nestguard.check_cache, TTL index), so it survives restarts.
# The demo route and the scenario spots are pre-computed at start-up and every 20 min.
import copy
import threading

TTL_LIVE_S, TTL_PAST_S = 30 * 60, 24 * 3600
_mem_cache = {}
CHECK_CACHE = None
if ZONES is not None:
    try:
        CHECK_CACHE = _client["nestguard"]["check_cache"]
        CHECK_CACHE.create_index("expires_at", expireAfterSeconds=0)
    except Exception as e:
        print("check cache in Mongo unavailable (memory only):", e)
        CHECK_CACHE = None


def _cache_key(lat, lon, date, height_ft=weather.DEFAULT_HEIGHT_FT):
    return f"{round(lat, 4)}:{round(lon, 4)}:{date.isoformat()}:h{height_ft}"


def _cache_get(key):
    hit = _mem_cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    if CHECK_CACHE is not None:
        try:
            doc = CHECK_CACHE.find_one({"_id": key, "expires_at": {"$gt": datetime.datetime.utcnow()}})
            if doc:
                exp = doc["expires_at"].replace(tzinfo=datetime.timezone.utc).timestamp()
                _mem_cache[key] = (exp, doc["result"])
                return doc["result"]
        except Exception as e:
            print("check cache read failed:", e)
    return None


def _cache_put(key, date, out):
    past = date < datetime.date.today() - datetime.timedelta(days=1)
    ttl = TTL_PAST_S if past else TTL_LIVE_S
    _mem_cache[key] = (time.time() + ttl, out)
    if CHECK_CACHE is not None:
        try:
            CHECK_CACHE.replace_one({"_id": key}, {"_id": key, "result": out, "expires_at":
                                    datetime.datetime.utcnow() + datetime.timedelta(seconds=ttl)}, upsert=True)
        except Exception as e:
            print("check cache write failed:", e)


def cached_check(lat, lon, date, explain_it=False, log=True, height_ft=weather.DEFAULT_HEIGHT_FT):
    key = _cache_key(lat, lon, date, height_ft)
    out = _cache_get(key)
    if out is None:
        out = score_spot(lat, lon, date, explain_it=explain_it, height_ft=height_ft)
        _cache_put(key, date, out)
    elif explain_it and not out.get("why"):
        out = dict(out, why=explain.why(out))     # cached without the sentence: add it once
        _cache_put(key, date, out)
    if explain_it and log and tiger.enabled():
        tiger.log_check(*snap(lat, lon), scoring.level_for(out["score"]), out["score"])  # app checks only
    out = copy.deepcopy(out)
    if not explain_it:
        out.pop("why", None)
    return out


TOUR = [(42.7302, -73.6788), (42.7317, -73.6889), (42.7310, -73.6915), (42.7493, -73.6941), (42.7466, -73.6677)]


def demo_spots():
    """What the demo clicks: the 5 guided tour stops (app/src/demo.js STOPS) and the scenario buttons."""
    today = lambda la, lo: weather.local_now(la, lo).date()      # the spot's own "today"
    spots = [(la, lo, today(la, lo)) for la, lo in TOUR]
    spots += [(42.7302, -73.6788, datetime.date(2027, 5, 15)),
              (33.7, -118.04, datetime.date(2021, 5, 13)),
              (42.7493, -73.6941, today(42.7493, -73.6941))]
    return spots


def _prewarm_loop():
    time.sleep(5)
    while True:
        t0 = time.time()
        try:
            spots = demo_spots()
        except Exception as e:
            print("pre-warm: spots failed:", e)
            spots = []
        for la, lo, d in spots:
            try:
                cached_check(la, lo, d, explain_it=True, log=False)
            except Exception as e:
                print(f"pre-warm {la},{lo} {d} failed:", e)
        print(f"pre-warm: {len(spots)} demo checks ready in {time.time() - t0:.0f} s")
        time.sleep(20 * 60)                       # well inside the 30 min cache life


if os.environ.get("NESTGUARD_PREWARM", "1") == "1":
    threading.Thread(target=_prewarm_loop, daemon=True).start()


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
          explain: bool = False, height_ft: Optional[int] = Query(None, ge=10, le=400)):
    """explain=true adds a Gemini "why" sentence (the app uses it; the device doesn't).
    An app check (explain=true) also becomes the device's location, so the device shows the
    spot the user just checked. The device's own checks never set explain, so no loop."""
    # height_ft = how high the pilot plans to fly (default 400 ft, the legal limit); low clouds only
    # count when they're under that height + 500 ft. The device doesn't send one: when it checks the
    # spot the app just set, it uses the app's height, so both show the same score.
    if height_ft is None:
        d = device["demo"] or {}
        same_spot = d.get("lat") is not None and round(float(d["lat"]), 4) == round(lat, 4) \
            and round(float(d["lon"]), 4) == round(lon, 4)
        height_ft = int(d.get("height_ft") or weather.DEFAULT_HEIGHT_FT) if same_spot else weather.DEFAULT_HEIGHT_FT
    if explain:
        device["demo"] = {"lat": lat, "lon": lon, "date": date.isoformat(), "from": "app", "height_ft": height_ft}
    return cached_check(lat, lon, date, explain_it=explain, height_ft=height_ft)


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
