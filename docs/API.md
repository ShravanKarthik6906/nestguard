# NestGuard API (backend, FastAPI)

Live: https://149-28-239-148.sslip.io (interactive docs at `/docs`)

**Privacy:** bird data is only ever stored and served as blurred ~1 km grid cells. Exact sighting
locations never reach the database, the API, logs or Gemini. Power lines are public map data, so
their geometry is exact.

**Data layers:** MongoDB Atlas (where: blurred zones, `2dsphere` + `$nearSphere`), Tiger Data /
TimescaleDB (when: sightings, device readings and checks as hypertables), eBird + iNaturalist
(birds), Open-Meteo (weather, history, air quality), OpenStreetMap via Overpass (power lines,
buildings; demo areas pre-loaded), Gemini (plain-English "why"), Fish Audio (spoken alerts).

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /check?lat=&lon=&date=YYYY-MM-DD&explain=false` | Pre-flight check (below). `explain=true` adds Gemini's `why`. |
| `GET /zones?lat=&lon=&radius_km=5&date=` | Blurred bird zones near a point, coloured for that date |
| `GET /powerlines?lat=&lon=&radius_km=1` | Power-line polylines, up to 3 km. **503** = data unavailable (not "no lines") |
| `GET /trend?lat=&lon=&date=` | Weekly sightings near a point (Tiger Data) |
| `GET /device/demo` / `POST /device/demo` | Device polls this; app sets `{"lat","lon","date"?}`, or `{}` to stop |
| `POST /device/telemetry` / `GET /device/telemetry` | Device readings `{"temp_c","light_pct","ts"}` |
| `GET /device/telemetry/history?minutes=60&bucket_s=60` | Device readings over time (Tiger Data) |
| `GET /stats/checks?hours=24` | Go / Wait / Don't fly counts per hour (Tiger Data) |
| `POST /speak` | `{"text": "..."}` -> spoken audio (Fish Audio) |
| `GET /debug/overpass` | Last Overpass error + one live test call |

## `/check` response

```json
{"level": "yellow", "score": 49, "bird_score": 34,
 "message": "Birds nearby, keep at least 70 m away",
 "reasons": ["Migration season: high bird activity", "Hawk or eagle sightings within 1 km"],
 "hazards": [
   {"type": "nesting",    "level": "yellow", "detail": "Outside nesting season, but busy: bird risk 34/100"},
   {"type": "raptors",    "level": "yellow", "detail": "Hawk or eagle sightings within 1 km"},
   {"type": "powerlines", "level": "green",  "detail": "No power lines within 1 km"},
   {"type": "crowd",      "level": "green",  "detail": "57 buildings within 300 m"},
   {"type": "migration",  "level": "yellow", "detail": "Migration season: high bird activity"},
   {"type": "air",        "level": "green",  "detail": "Air quality index 36"},
   {"type": "wind",       "level": "green",  "detail": "4 mph gusts, 1 mph at drone height"},
   {"type": "rain",       "level": "green",  "detail": "No rain, 43F"},
   {"type": "visibility", "level": "green",  "detail": "Visibility 13.4 mi"},
   {"type": "clouds",     "level": "green",  "detail": "Low clouds 0%"}],
 "checks": {"wildlife": "yellow", "safety": "green", "legal": "green"},
 "raptor_alert": "Hawks or eagles seen within 1 km...",
 "safer_spot": null,
 "best_time": "No clear window; least risky Tomorrow 7 AM to sunset",
 "trend": {"recent": 39, "before": 3, "ratio": null, "weekly": [{"week": "2026-11-02", "sightings": 39}]},
 "zones": [{"lat": 42.725, "lon": -73.675, "radius_m": 500, "level": "green"}],
 "why": "Wait: migration season and hawks nearby mean high bird activity."}
```

- `level` = the **worst** hazard: `green` (Go), `yellow` (Wait), `red` (Don't fly). `unknown` hazards are ignored.
- `score` = overall risk 0-100 and always matches the level: green 0-29, yellow 30-59, red 60-100.
  It is the bird risk plus 15 per yellow and 40 per red non-bird hazard. `bird_score` = birds only.
- `safer_spot` = nearest better spot within 3 km (`{"lat","lon","distance_km","direction","level","label"}`),
  or `null` when area-wide hazards (weather, migration, air) mean moving won't help.
- `trend.ratio` is `null` unless the earlier weeks have a real baseline.

## How the score works

1. **Wildlife:** each blurred zone within 2 km scores proximity × sighting count × recency ×
   nesting season × bird group (colony nesters ×1.5, raptors ×1.2 in season). The zones combine as
   independent chances into one 0-100 bird risk.
2. **Multipliers:** cold or rain ×1.3 (nesting season only: eggs chill), migration with high
   activity ×1.2, rising sightings ×1.15 (Tiger Data, needs a baseline).
3. **Hazards:** raptors, power lines (red ≤ 100 m, yellow ≤ 300 m), crowd (≥ 150 buildings in 300 m),
   migration (Mar-Jun, Aug-Nov), air (US AQI > 150), wind (gusts ≥ 25 mph or ≥ 20 mph at 80 m),
   rain, FAA visibility (< 3 mi) and cloud clearance (cloud base < 900 ft).
4. **Overall level** = the worst hazard. Every source is optional: if it is down, it reports
   `unknown` and never makes the answer looser.
