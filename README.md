# NestGuard

### Will my drone make it back?

NestGuard is a pre-flight safety check for drone pilots. Pick a spot and a date, and it gives you **one risk score from 0 to 100** for that flight, the hazards behind it, the reason in plain English, a lower-risk spot nearby and the best time to fly. A small device on the pilot's side lights up with the same score, so you see it at the launch site without opening your phone.

- **Live app:** https://149-28-239-148.sslip.io
- **API docs (interactive):** https://149-28-239-148.sslip.io/docs
- **API reference:** [docs/API.md](docs/API.md)

Built at **HackRPI 2026**.

---

## Contents

1. [The problem](#the-problem)
2. [What NestGuard does](#what-nestguard-does)
3. [What a check looks like](#what-a-check-looks-like)
4. [The hazards it checks](#the-hazards-it-checks)
5. [FAA rules built in](#faa-rules-built-in)
6. [How the risk score works](#how-the-risk-score-works)
7. [Missing data is never "safe"](#missing-data-is-never-safe)
8. [Lower-risk spot and best time to fly](#lower-risk-spot-and-best-time-to-fly)
9. [The pilot-side device](#the-pilot-side-device)
10. [Works anywhere, answers fast](#works-anywhere-answers-fast)
11. [Architecture](#architecture)
12. [API](#api)
13. [Run it yourself](#run-it-yourself)
14. [Repo layout](#repo-layout)
15. [What NestGuard does not do](#what-nestguard-does-not-do)
16. [Privacy](#privacy)
17. [Team](#team)

---

## The problem

Most drone losses don't come from a broken drone. They come from flying in the wrong place at the wrong time:

- **Power lines** are thin, hard to see on a phone screen and easy to drift into.
- **Gusts** at drone height are often much stronger than what you feel on the ground, and they cause flyaways.
- **Low clouds, haze and smoke** make you lose sight of the drone, and flying in them breaks FAA rules.
- **Hawks and eagles** attack drones that fly near them, and a strike can bring a drone down.
- **Crowds** below turn a small crash into an injury, and flying over people has its own rules.

The information to avoid all of this exists, but it's spread across weather apps, maps, aviation forecasts and birding sites. Few pilots check five apps before every flight. **NestGuard checks all of it in one step and turns it into one number.**

## What NestGuard does

For any spot and date, NestGuard returns:

| Output | What it tells you |
|---|---|
| **Risk score (0-100)** | How risky this flight is. Low 0-29, medium 30-59, high 60-100. |
| **Summary** | The score and its main cause, such as `Risk 82/100: Power line 40 m away`. |
| **Hazard breakdown** | Every hazard with a low / medium / high dot and the measurement behind it. |
| **Why** | One plain-English sentence from Gemini explaining the score. |
| **Lower-risk spot** | The nearest spot within 3 km with a lower score, such as `1 km southeast: risk 14`. |
| **Best time to fly** | The first daylight window today or tomorrow with the lowest risk. |
| **Voice** | The result read out loud (Fish Audio), so you can keep your eyes up. |
| **Device** | The same score on an LCD and LEDs next to the pilot. |

NestGuard gives you the risk and the reasons, and **the pilot makes the call**. There's no "go / no-go" verdict: a score with the reasons behind it is more honest than a yes or no.

## What a check looks like

An example (the numbers are illustrative):

```
Risk 82/100: Power line 40 m away

  Power lines   HIGH    Power line 40 m away
  Wind          MEDIUM  27 mph gusts, 18 mph at drone height
  Hawks/eagles  MEDIUM  Hawk or eagle sightings within 1 km
  Cloud base    LOW     Cloud base about 2400 ft
  Visibility    LOW     Visibility 9.4 mi
  Rain          LOW     No rain, 48F
  People below  LOW     12 buildings within 300 m
  Air quality   LOW     Air quality index 36

Why: A power line 40 m away is the main danger here, and gusty wind makes drifting into it more likely.
Lower-risk spot: 1 km southeast: risk 24
Best time: Lowest risk: Tomorrow 7 AM to 11 AM
```

## The hazards it checks

| Hazard | Why it matters for your drone | Data source | Medium | High |
|---|---|---|---|---|
| **Power lines** | Collision. Lines are thin and hard to judge from the camera view. | OpenStreetMap (Overpass) | within 300 m | within 100 m |
| **Wind** | Flyaways, drift, battery drain fighting the wind. | Open-Meteo: gusts at 10 m and wind at 80 m (drone height) | gusts ≥ 25 mph or ≥ 20 mph at 80 m | |
| **Cloud base** | Losing sight of the drone; FAA cloud clearance. | Open-Meteo (temperature, dew point, low cloud cover) | | below 900 ft |
| **Visibility** | Losing sight of the drone; FAA minimum. | Open-Meteo | | below 3 statute miles |
| **Rain** | Water damage, sensor and motor failure, poor visibility. | Open-Meteo | heavy rain (≥ 2.5 mm/h) | |
| **People below** | Injury risk if the drone falls; rules on flying over people. | OpenStreetMap buildings | ≥ 150 buildings within 300 m | |
| **Air quality / smoke** | Smoke cuts visibility and can hide the drone. | Open-Meteo air quality (US AQI) | AQI above 150 | |
| **Hawks and eagles** | Raptors attack drones; higher risk during their nesting season. | eBird + iNaturalist sightings within 1 km | sightings nearby | sightings nearby during nesting season |
| **Bird activity** | Bird-strike risk is higher during migration and at wildlife hotspots. | eBird + iNaturalist, by season | migration season, or a busy hotspot | a very busy hotspot in its peak season |

Weather is checked for the exact date: the forecast for today and the coming days, and the historical archive for past dates, so a past flight can be replayed.

## FAA rules built in

The weather limits come from the FAA's small-drone rules (Part 107), which also guide recreational flying:

- **Visibility of at least 3 statute miles:** below that, the visibility row is high.
- **Stay 500 ft below the clouds:** with the 400 ft altitude limit, that means the cloud base must be at least **900 ft** (400 + 500). Below that, the cloud row is high.
- **Flying over people:** dense areas raise the "people below" row.

NestGuard estimates the cloud base from the temperature and dew-point spread, and uses it only when low cloud cover is 50% or more.

## How the risk score works

1. **Every hazard gets a level** (low, medium or high) from its measurement, as in the table above.
2. **The worst hazard sets the band.** A single high hazard (a power line 40 m away) makes the flight high risk (60-100), whatever else is true. You can't average a power line away.
3. **Within the band, the score adds up:**
   - the **wildlife part:** sightings near the spot, weighted by distance, how many, how recent and the season;
   - **15 points** for each other medium hazard and **40** for each other high hazard;
   - **up to 4 / 15 / 20 more points** for how severe the measurement is within its level. A line at 40 m scores higher than one at 95 m, and 40 mph gusts score higher than 26 mph gusts.
4. **The score is kept inside its band,** so the number always agrees with the worst hazard.

The weather also multiplies the wildlife part. Cold, rain and busy migration raise it, and so does a recent jump in sightings, when there's enough history to compare against.

## Missing data is never "safe"

Every data source can fail. When one does, its row says **"No data here"** (shown in grey) and the app shows how complete the check is ("8 of 10 data sources available"). A missing source **never lowers the score**. The app tells you which hazards you need to check yourself.

## Lower-risk spot and best time to fly

- **Lower-risk spot:** NestGuard scores candidate spots in 8 directions, from 0.5 to 3 km away, using the same rules (power lines and buildings there, sightings there, the same weather). It suggests the nearest spot in a lower band, or the nearest one at least a few points lower. The weather is the same across the area, so the spots differ by what's local: power lines, buildings and wildlife.
- **Best time to fly:** for today, it scans every daylight hour from now to the end of tomorrow and reports the first window with the lowest risk. For other dates, it scans that day's daylight hours.

## The pilot-side device

A small box that sits next to the pilot and shows the score for where they're flying.

**Hardware:** NVIDIA Jetson Orin Nano, 16x2 Grove RGB LCD, red and green LEDs, a 28BYJ-48 stepper on a ULN2003 driver (camera pan), and an optional I2C temperature sensor.

**What it shows:**

| Risk | LCD | LEDs | Backlight |
|---|---|---|---|
| Low (0-29) | `RISK 12` | green | green |
| Medium (30-59) | `RISK 45` | green + red | amber |
| High (60-100) | `RISK 82` | red | red |
| No location yet | `Waiting for GPS` | green + red | amber |
| Lost contact for 5 s | `NO LINK` | red blinking | red |

**How it stays in sync:** whenever someone checks a spot in the app, the server remembers it, and the device polls the server every few seconds and runs the same check. The app and the device always show the same score. The device also saves the nearby zones, so it can still warn about a known hotspot when it's offline.

**Wiring (40-pin header):** red LED on pin 7, green LED on pin 15, ground on pin 14. LCD SDA on pin 3, SCL on pin 5, VCC on pin 2 (5 V, which the LCD's text chip needs), GND on pin 9. Stepper IN1-IN4 on pins 29, 31, 32, 33, with VCC on 5 V. On JetPack 6 the header pins start as inputs, so `nestguard_hw.py` switches them to outputs at start-up (the pin registers come from NVIDIA's Jetson.GPIO pin table).

## Works anywhere, answers fast

- **Any location:** places outside the pre-loaded demo areas get live eBird and iNaturalist data on their first check. Sightings are blurred to a 1 km grid, saved, and reused for 24 hours. Power lines and buildings come from OpenStreetMap, and weather from Open-Meteo, worldwide.
- **Fast:** every check result is cached in MongoDB for 30 minutes (today and future dates, since the weather changes) or 24 hours (past dates). Repeat checks take a few milliseconds. The demo route and scenarios are computed when the server starts and every 20 minutes after.

## Architecture

```
  Web app (Vite + Leaflet) ──┐                        ┌── MongoDB Atlas: wildlife zones (2dsphere), check cache
                             ├──> FastAPI on Vultr ───┼── Tiger Data (TimescaleDB): checks, device readings, trends
  Jetson device ─────────────┘    (Caddy, HTTPS)      ├── Open-Meteo: weather, history, air quality
                                                      ├── OpenStreetMap / Overpass: power lines, buildings
                                                      ├── eBird + iNaturalist: bird sightings
                                                      ├── Gemini: the one-sentence "why"
                                                      └── Fish Audio: spoken alerts
```

| Layer | Tech |
|---|---|
| Backend | Python, FastAPI, Uvicorn |
| Databases | MongoDB Atlas (geospatial zones and cache), Tiger Data / TimescaleDB (time series) |
| Frontend | Vite, vanilla JS, Leaflet, Mapbox satellite tiles (OpenStreetMap fallback) |
| AI | Google Gemini (explanations), Fish Audio (voice) |
| Hosting | Vultr VM, Caddy (automatic HTTPS), systemd |
| Device | NVIDIA Jetson Orin Nano, Python, Jetson.GPIO, smbus2 |

## API

| Endpoint | Purpose |
|---|---|
| `GET /check?lat=&lon=&date=YYYY-MM-DD&explain=false` | The pre-flight check. `explain=true` adds Gemini's "why". |
| `GET /powerlines?lat=&lon=&radius_km=1` | Power-line shapes near a point, for the map (503 = data unavailable, not "no lines") |
| `GET /zones?lat=&lon=&radius_km=5&date=` | Wildlife hotspots near a point, with a risk for that date |
| `GET /trend?lat=&lon=&date=` | Weekly activity near a point |
| `GET /device/demo`, `POST /device/demo` | The location the device follows (`{}` = none) |
| `POST /device/telemetry`, `GET /device/telemetry` | Device readings |
| `GET /stats/checks?hours=24` | Checks per hour with average and highest risk |
| `POST /speak` | Text to speech (Fish Audio) |

Full details and the response format: [docs/API.md](docs/API.md)

## Run it yourself

**Backend**
```bash
cd backend
python -m venv venv
venv/bin/pip install -r requirements.txt
# backend/.env: MONGODB_URI, GEMINI_API_KEY, EBIRD_KEY, FISH_AUDIO_API_KEY, TIGER_URL (each one optional)
venv/bin/python -m uvicorn main:app --reload --port 8000      # http://localhost:8000/docs
```

**Web app** (second terminal)
```bash
cd app
npm install
API_TARGET=http://localhost:8000 npm run dev                  # http://localhost:5173
```

**Device** (on the Jetson)
```bash
cd ~/nestguard
venv/bin/pip install smbus2 Jetson.GPIO
sudo venv/bin/python nestguard_hw.py --demo     # hardware test: LEDs, LCD, camera pan
sudo venv/bin/python jetson_direct.py           # the real thing
```

**Server:** `deploy/setup.sh` installs everything on a fresh Ubuntu VM: the API as a systemd service, the built app, and Caddy for HTTPS. See [deploy/DEPLOY.md](deploy/DEPLOY.md).

## Repo layout

| Folder | What's in it |
|---|---|
| `backend/` | FastAPI app: `main.py` (API, score, cache), `hazards.py` (power lines, crowds, migration, air), `weather.py` (weather and FAA limits), `scoring.py` (wildlife risk), `live_zones.py` (data for new areas), `explain.py` (Gemini), `speak.py` (Fish Audio), `tiger.py` (Tiger Data) |
| `app/` | Web app: landing page and the pre-flight check (Location → Assessment → Explore) |
| `device/nestguard/` | Device code: `jetson_direct.py` (runs the device), `nestguard_hw.py` (LEDs, LCD, stepper, sensor), `nestguard.py` (shared logic) |
| `deploy/` | Caddy config, systemd service, setup script |
| `docs/` | API reference and design rules |

## What NestGuard does not do

NestGuard helps you judge risk. It is **not** an airspace authorization tool:

- It does **not** check controlled airspace, temporary flight restrictions (TFRs) or airport distances. Use the FAA's B4UFLY or a LAANC provider for that.
- It does not replace your own look at the site. Trees, buildings and new obstacles may not be on the map.
- Weather and map data can be wrong or out of date. If a row says "No data here", check it yourself.

## Privacy

- NestGuard never asks for or stores the pilot's identity. Checks are logged only as a blurred ~1 km cell, a score and a time.
- Wildlife sightings are stored only as blurred ~1 km cells, never as exact points.
- Gemini only sees the score and the hazard text, never coordinates.
- All keys stay in the server's `.env`, which is never committed.

## Team

| | Role |
|---|---|
| **Udaya** | Backend, data, risk score, privacy |
| **Shravan** | Web app and UI, hosting, voice, domain |
| **Ryan** | Hardware |
| **Dhruv** | Device mount, demo, pitch, Devpost |
