# KnowFlyZone flight simulator

A 3D practice flight for the spot you checked in KnowFlyZone. Served at `knowflyzone.vip/fly/`.
Open it from the app ("Fly this spot in 3D"), or go to `/fly/?lat=42.7493&lon=-73.6941`.

- Pre-flight panel: the same risk score as the app (from `/check`), plus live weather (Open-Meteo),
  mapped power lines (OpenStreetMap), recent wildlife reports (iNaturalist) and a Gemini explanation.
- Fly: W and S forward and back, A and D slide, Q and E down and up, arrow keys turn.
- After landing: a mission summary and a PDF report.

Practice only. It does not check airspace or authorize a real flight.

## Parts
- `src/` React page (Vite). 3D view: Cesium with Google Photorealistic 3D Tiles.
- `server/index.js` small Node backend on 127.0.0.1:3001 (Gemini explanation, power line lookup).
  Caddy forwards `/api/*` to it. It reads `GEMINI_API_KEY` from `backend/.env`.

## Needs
- Node 22 or newer (setup.sh installs a private copy in /opt/node22 on the server).
- A Cesium ion token in `sim/.env.local` (git ignores it):
  `VITE_CESIUM_ION_ACCESS_TOKEN=...`

## Run on a laptop
```
cd sim
npm install
npm run server
```
Then in a second terminal: `npm run dev`, and open http://localhost:5173/fly/
