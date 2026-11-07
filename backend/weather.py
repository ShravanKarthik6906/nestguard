"""
U5 + U6: weather from Open-Meteo (no key needed), cached.

conditions(lat, lon, date) -> one hour of weather (now for today, noon otherwise), or None
assess(w) -> (risk_multiplier, reasons, minimum_level, checks)

  U5 wildlife multiplier: cold (< 45 F) or rain -> x1.3 (birds stay on nests, eggs chill faster)
  U6 drone safety:  gusts >= 25 mph or wind at 80 m >= 20 mph or heavy rain -> at least "yellow" (Wait)
  U6 legal (FAA Part 107): visibility < 3 statute miles -> "red";
        cloud base under 900 ft (400 ft max altitude + 500 ft below clouds) -> "red"
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
MIN_CLOUD_BASE_FT = 900

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
              "temperature_unit": "fahrenheit", "wind_speed_unit": "mph", "timezone": "auto"}
    if url == ARCHIVE:
        params["hourly"] = ",".join(h for h in HOURLY if h != "visibility")  # not in archive
    r = requests.get(url, params=params, timeout=8)
    r.raise_for_status()
    return r.json()


def conditions(lat, lon, date):
    """Weather for one hour at this spot. Cached by ~1 km cell, date and hour."""
    key = f"{round(lat, 2)},{round(lon, 2)},{date.isoformat()}"
    if key not in _cache:
        try:
            _cache[key] = _fetch(round(lat, 2), round(lon, 2), date)
            _save_cache()
        except Exception as e:
            print("weather fetch failed:", e)
            return None
    data = _cache[key]
    if not data or "hourly" not in data:
        return None
    h = data["hourly"]
    if date == datetime.date.today():
        local = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(seconds=data.get("utc_offset_seconds", 0))
        hour = local.hour
    else:
        hour = 12
    hour = min(hour, len(h["time"]) - 1)
    w = {name: (h.get(name) or [None] * 24)[hour] for name in HOURLY}
    w["time"] = h["time"][hour]
    return w


def assess(w):
    """Returns (multiplier, reasons, minimum level, checks)."""
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
    if cold or wet:
        mult = 1.3
        parts = ([f"{t:.0f}F"] if cold else []) + (["rain"] if wet else [])
        reasons.append(" and ".join(parts) + ": eggs chill faster if birds are flushed")

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
        if base_ft < MIN_CLOUD_BASE_FT:
            reasons.append(f"Clouds about {base_ft:.0f} ft (need 500 ft clearance)")
            checks["legal"] = "red"

    rank = {"green": 0, "yellow": 1, "red": 2}
    minimum = max(checks.values(), key=lambda l: rank[l])
    return mult, reasons, minimum, checks
