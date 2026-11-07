# nestguard
## API (backend, FastAPI)

Live docs: http://129.161.92.50:8000/docs (Udaya's laptop for now, Vultr later)

All responses are JSON. Zones are blurred to a ~1 km grid: never exact nest locations.

| Endpoint | Purpose |
|---|---|
| `GET /zones?lat=&lon=&radius_km=5` | Zones near a point (for the map) |
| `GET /check?lat=&lon=&date=YYYY-MM-DD` | Pre-flight check, returns the handoff message |
| `GET /device/demo` | Device polls this; `{}` means demo is off |
| `POST /device/demo` | App sets a fake location `{"lat":..,"lon":..}`, or `{}` to stop |
| `POST /device/telemetry` | Device sends `{"temp_c":..,"light_pct":..,"ts":..}` every 10 s |
| `GET /device/telemetry` | App reads the latest device readings |

### Handoff message (`/check` response)
```json
{"level": "red", "score": 82, "message": "Nesting zone, climb to 300 ft",
 "reasons": ["Hawk sightings within 1 km", "Nesting season", "40F and rain"],
 "zones": [{"lat": 42.735, "lon": -73.675, "radius_m": 200, "level": "red"}],
 "best_time": "Tomorrow 10 AM to 1 PM"}
```
- `level`: `green` (Go), `yellow` (Wait), `red` (Don't fly)
- `score`: 0 to 100
- `best_time`: null until it's built

### Zone object (`/zones` returns a list of these)
```json
{"lat": 42.735, "lon": -73.675, "radius_m": 200, "level": "red"}
```

Responses are mock data until the real score is done (~7 PM). The shapes won't change.
