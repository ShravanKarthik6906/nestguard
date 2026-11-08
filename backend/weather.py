"""
U5 + U6: weather from Open-Meteo (no key needed), cached.

conditions(lat, lon, date) -> one hour of weather (now for today, noon otherwise), or None
assess(w) -> (risk_multiplier, reasons, minimum_level, checks)

  U5 wildlife multiplier: cold (< 45 F) or rain -> x1.3 (birds stay on nests, eggs chill faster)
  U6 drone safety:  gusts >= 25 mph or wind at 80 m >= 20 mph or heavy rain -> at least "yellow" (Wait)
  U6 legal (FAA Part 107): visibility < 3 statute miles -> "red";
        cloud base under the planned height + 500 ft (default 200 ft -> 700 ft; 400 ft max -> 900 ft) -> "red"
  Forecasts for today and later are re-fetched every 30 min.
  Cloud base estimate: (temp F - dew point F) / 4.4 x 1000 ft, used when low cloud cover >= 50 %.
"""
import datetime
import json
import pathlib

import requests

CACHE_FILE = pathlib.Path(__file__).parent / ".cache" / "weather.json"
FORECAST = "https://api.open-meteo.com/v1/forecast"
ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
HOURLY = ["temperature_2m", "dew_point_2m", "precipitation", "wind_speed_80m",
          "wind_gusts_10m", "cloud_cover_low", "visibility"]

COLD_F, RAIN_MM, HEAVY_RAIN_MM = 45, 0.2, 2.5
GUST_MPH, WIND80_MPH = 25, 20
MIN_VIS_M = 4828                    # 3 statute miles
MIN_CLOUD_BASE_FT = 900          # for a flight up to 400 ft (the legal limit)
DEFAULT_HEIGHT_FT = 200          # planned height when none is given: a typical hobby flight (100-200 ft)
FRESH_S = 30 * 60                # today's and future forecasts are re-fetched after 30 min
CLOUD_MARGIN_FT = 200            # clouds within 200 ft above the limit: medium (little room for error)


def cloud_need_ft(height_ft=DEFAULT_HEIGHT_FT):
    """Lowest safe cloud base for a flight up to height_ft: stay 500 ft below the clouds."""
    return height_ft + 500

try:
    _cache = json.loads(CACHE_FILE.read_text())
except Exception:
    _cache = {}


def _save_cache():
    try:
        CACHE_FILE.parent.mkdir(exist_ok=True)
        CACHE_FILE.write_text(json.dumps(_cache))
    except Exception:
        pass


def _fetch(lat, lon, date):
    today = datetime.date.today()
    if (date - today).days > 15:
        return None                                   # beyond the forecast range
    url = FORECAST if (today - date).days <= 80 else ARCHIVE
    params = {"latitude": lat, "longitude": lon, "hourly": ",".join(HOURLY),
              "start_date": date.isoformat(), "end_date": date.isoformat(),
              "daily": "sunrise,sunset",
              "temperature_unit": "fahrenheit", "wind_speed_unit": "mph", "timezone": "auto"}
    if url == ARCHIVE:
        params["hourly"] = ",".join(h for h in HOURLY if h != "visibility")  # not in archive
    r = requests.get(url, params=params, timeout=8)
    r.raise_for_status()
    return r.json()


_fail_until = {}


def _day(lat, lon, date):
    # weather is shared across a ~10 km cell: it doesn't change over a few km, and it means far
    # fewer requests (Open-Meteo rate limits). A failed cell is retried after 60 s, not every check.
    lat, lon = round(lat, 1), round(lon, 1)
    key = f"{lat},{lon},{date.isoformat()}"
    import time as _t
    hit = _cache.get(key)
    # past days never change; today's and future forecasts get re-fetched every 30 min so the
    # score follows the latest forecast (entries saved before this had no time: re-fetch them)
    stale = hit is not None and date >= datetime.date.today() - datetime.timedelta(days=1) and \
        _t.time() - ((hit or {}).get("_fetched") or 0) > FRESH_S
    if hit is None or stale:
        if _t.time() < _fail_until.get(key, 0):
            return hit if hit and "hourly" in hit else None      # keep the older forecast meanwhile
        try:
            data = _fetch(lat, lon, date)
            if isinstance(data, dict):
                data["_fetched"] = _t.time()
            _cache[key] = data
            _save_cache()
        except Exception as e:
            print("weather fetch failed:", e)
            _fail_until[key] = _t.time() + 60
            return hit if hit and "hourly" in hit else None      # older forecast beats none
    data = _cache[key]
    return data if data and "hourly" in data else None


def local_now(lat, lon):
    data = _day(lat, lon, datetime.date.today())
    off = (data or {}).get("utc_offset_seconds", 0)
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(seconds=off)


def hours(lat, lon, date):
    """[(local datetime, weather dict, is_daylight)] for every hour of that date."""
    data = _day(lat, lon, date)
    if not data:
        return []
    h = data["hourly"]
    daily = data.get("daily") or {}
    try:
        rise = datetime.datetime.fromisoformat(daily["sunrise"][0])
        sset = datetime.datetime.fromisoformat(daily["sunset"][0])
    except (KeyError, IndexError, ValueError, TypeError):
        rise = datetime.datetime.combine(date, datetime.time(7))
        sset = datetime.datetime.combine(date, datetime.time(18))
    out = []
    for i, t in enumerate(h["time"]):
        when = datetime.datetime.fromisoformat(t)
        w = {name: (h.get(name) or [None] * len(h["time"]))[i] for name in HOURLY}
        w["time"] = t
        out.append((when, w, rise <= when < sset))
    return out


def conditions(lat, lon, date):
    """Weather for one hour at this spot: the current hour for today, noon otherwise."""
    hs = hours(lat, lon, date)
    if not hs:
        return None
    hour = local_now(lat, lon).hour if date == datetime.date.today() else 12
    return hs[min(hour, len(hs) - 1)][1]


def assess(w, egg_season=True, height_ft=DEFAULT_HEIGHT_FT):
    """Returns (multiplier, reasons, minimum level, checks). egg_season=False drops the
    cold/rain egg-chilling factor (no eggs outside nesting season)."""
    checks = {"safety": "green", "legal": "green"}
    if not w:
        return 1.0, ["Weather unavailable for this date"], "green", {"safety": None, "legal": None}
    reasons, mult, minimum = [], 1.0, "green"
    t, rain = w.get("temperature_2m"), w.get("precipitation") or 0
    gust, wind80 = w.get("wind_gusts_10m"), w.get("wind_speed_80m")
    vis, low, dew = w.get("visibility"), w.get("cloud_cover_low"), w.get("dew_point_2m")

    # U5: wildlife multiplier
    cold = t is not None and t < COLD_F
    wet = rain >= RAIN_MM
    if (cold or wet) and egg_season:
        mult = 1.3
        parts = ([f"{t:.0f}F"] if cold else []) + (["rain"] if wet else [])
        bird_note = " and ".join(parts) + ": eggs chill faster if birds are flushed"
    else:
        bird_note = None

    # U6: drone safety -> Wait
    if gust is not None and gust >= GUST_MPH:
        reasons.append(f"Gusts {gust:.0f} mph")
        checks["safety"] = "yellow"
    if wind80 is not None and wind80 >= WIND80_MPH:
        reasons.append(f"Wind {wind80:.0f} mph at drone height")
        checks["safety"] = "yellow"
    if rain >= HEAVY_RAIN_MM:
        reasons.append("Heavy rain")
        checks["safety"] = "yellow"

    # U6: legal (FAA) -> Don't fly
    if vis is not None and vis < MIN_VIS_M:
        reasons.append(f"Visibility {vis / 1609:.1f} mi (under 3 mi legal minimum)")
        checks["legal"] = "red"
    if low is not None and low >= 50 and t is not None and dew is not None:
        base_ft = max(0, (t - dew) / 4.4 * 1000)
        if base_ft < cloud_need_ft(height_ft):
            reasons.append(f"Cloud base about {base_ft:.0f} ft: too low to fly at {height_ft} ft and stay 500 ft below clouds")
            checks["legal"] = "red"
        elif base_ft < cloud_need_ft(height_ft) + CLOUD_MARGIN_FT:
            reasons.append(f"Cloud base about {base_ft:.0f} ft: close to the limit for a {height_ft} ft flight")
            if checks["safety"] == "green":
                checks["safety"] = "yellow"

    if bird_note:
        reasons.append(bird_note)                     # safety/legal reasons come first
    rank = {"green": 0, "yellow": 1, "red": 2}
    minimum = max(checks.values(), key=lambda l: rank[l])
    return mult, reasons, minimum, checks


def hazards(w, height_ft=DEFAULT_HEIGHT_FT):
    """Weather as hazard entries for the /check breakdown (same rules as assess())."""
    if not w:
        return [{"type": "weather", "level": "unknown", "detail": "Weather unavailable for this date"}]
    out = []
    gust, wind80 = w.get("wind_gusts_10m"), w.get("wind_speed_80m")
    if gust is not None or wind80 is not None:
        windy = (gust or 0) >= GUST_MPH or (wind80 or 0) >= WIND80_MPH
        parts = ([f"{gust:.0f} mph gusts"] if gust is not None else []) + \
                ([f"{wind80:.0f} mph at drone height"] if wind80 is not None else [])
        r = max((gust or 0) / GUST_MPH, (wind80 or 0) / WIND80_MPH)       # 1.0 = at the limit
        out.append({"type": "wind", "level": "yellow" if windy else "green", "detail": ", ".join(parts),
                    "sev": r - 1 if windy else r})
    rain, t = w.get("precipitation") or 0, w.get("temperature_2m")
    out.append({"type": "rain", "level": "yellow" if rain >= HEAVY_RAIN_MM else "green",
                "detail": "Heavy rain" if rain >= HEAVY_RAIN_MM else
                ("Light rain" if rain >= RAIN_MM else "No rain") + (f", {t:.0f}F" if t is not None else ""),
                "sev": rain / HEAVY_RAIN_MM - (1 if rain >= HEAVY_RAIN_MM else 0)})
    vis = w.get("visibility")
    if vis is not None:
        out.append({"type": "visibility", "level": "red" if vis < MIN_VIS_M else "green",
                    "detail": f"Visibility {vis / 1609:.1f} mi" + (" (legal minimum is 3 mi)" if vis < MIN_VIS_M else ""),
                    "sev": (MIN_VIS_M - vis) / MIN_VIS_M if vis < MIN_VIS_M else (16093 - vis) / (16093 - MIN_VIS_M)})
    low, dew = w.get("cloud_cover_low"), w.get("dew_point_2m")
    if low is not None and t is not None and dew is not None:
        base = max(0, (t - dew) / 4.4 * 1000)
        need = cloud_need_ft(height_ft)                # planned height + 500 ft below the clouds
        too_low = low >= 50 and base < need
        close = low >= 50 and not too_low and base < need + CLOUD_MARGIN_FT
        out.append({"type": "clouds", "level": "red" if too_low else "yellow" if close else "green",
                    "detail": (f"Cloud base about {base:.0f} ft" +
                               (f" (a {height_ft} ft flight needs {need} ft)" if too_low else
                                f" (close to the {need} ft limit for a {height_ft} ft flight)" if close else ""))
                    if low >= 50 else f"Low clouds {low:.0f}%",
                    # red: how far below the limit; yellow: how little room is left above it;
                    # green: low cloud cover x how close the base is to the limit
                    "sev": min(1.0, (need - base) / 300) if too_low else      # 300+ ft short = worst
                           (need + CLOUD_MARGIN_FT - base) / CLOUD_MARGIN_FT if close else
                           max(0.0, low / 100 * (3000 - base) / (3000 - need - CLOUD_MARGIN_FT))})
    return out
