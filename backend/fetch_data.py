#!/usr/bin/env python3
"""
U1: pull all the raw data for both demo spots and save it to data/.
  pip install requests
  export EBIRD_KEY=your_key        (Windows: set EBIRD_KEY=your_key)
  python fetch_data.py
iNaturalist and Open-Meteo need no key. Re-running overwrites the files.
"""
import json
import os
import pathlib

import requests

OUT = pathlib.Path(__file__).parent / "data"
OUT.mkdir(exist_ok=True)
EBIRD_KEY = os.environ.get("EBIRD_KEY", "")

RPI = (42.73, -73.68)                  # RPI campus, Troy NY
BOLSA = (33.70, -118.05)               # Bolsa Chica Ecological Reserve, CA
BOLSA_DATE = (2021, 5, 13)
BOLSA_REGION = "US-CA-059"             # Orange County, CA (eBird region code)


def save(name, data):
    path = OUT / name
    path.write_text(json.dumps(data, indent=1))
    n = len(data) if isinstance(data, list) else len(data.get("results", data))
    print(f"saved {path.name}: {n} items")


def get(url, **kw):
    r = requests.get(url, timeout=30, **kw)
    r.raise_for_status()
    return r.json()


def ebird_recent(lat, lon):
    return get("https://api.ebird.org/v2/data/obs/geo/recent",
               headers={"X-eBirdApiToken": EBIRD_KEY},
               params={"lat": lat, "lng": lon, "dist": 10, "back": 30})


def ebird_historic(region, y, m, d):
    return get(f"https://api.ebird.org/v2/data/obs/{region}/historic/{y}/{m}/{d}",
               headers={"X-eBirdApiToken": EBIRD_KEY})


def inat(lat, lon, d1=None, d2=None):
    params = {"lat": lat, "lng": lon, "radius": 5, "iconic_taxa": "Aves",
              "per_page": 200, "order_by": "observed_on", "quality_grade": "research"}
    if d1:
        params.update(d1=d1, d2=d2)
    return get("https://api.inaturalist.org/v1/observations", params=params)


HOURLY = "temperature_2m,precipitation,wind_speed_80m,wind_gusts_10m,cloud_cover_low,visibility"


def weather_forecast(lat, lon):
    return get("https://api.open-meteo.com/v1/forecast",
               params={"latitude": lat, "longitude": lon, "hourly": HOURLY,
                       "daily": "sunrise,sunset", "forecast_days": 2,
                       "temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
                       "timezone": "auto"})


def weather_history(lat, lon, day):
    return get("https://archive-api.open-meteo.com/v1/archive",
               params={"latitude": lat, "longitude": lon, "start_date": day, "end_date": day,
                       "hourly": "temperature_2m,precipitation,wind_speed_100m,wind_gusts_10m,cloud_cover_low",
                       "daily": "sunrise,sunset",
                       "temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
                       "timezone": "auto"})


def step(name, fn, *args):
    try:
        save(name, fn(*args))
    except Exception as e:
        print(f"FAILED {name}: {e}")


if __name__ == "__main__":
    if not EBIRD_KEY:
        print("No EBIRD_KEY set - skipping eBird (get one at ebird.org/api/keygen)")
    else:
        step("rpi_ebird_recent.json", ebird_recent, *RPI)
        step("bolsa_ebird_2021-05-13.json", ebird_historic, BOLSA_REGION, *BOLSA_DATE)
    step("rpi_inat.json", inat, *RPI)
    step("bolsa_inat_may2021.json", inat, *BOLSA, "2021-05-01", "2021-05-31")
    step("rpi_weather.json", weather_forecast, *RPI)
    step("bolsa_weather_2021-05-13.json", weather_history, *BOLSA, "2021-05-13")
