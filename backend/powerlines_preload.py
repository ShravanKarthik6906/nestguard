#!/usr/bin/env python3
"""
Pre-load OpenStreetMap power lines + building positions for the demo areas into
powerlines_preload.json (commit it). The server then answers these areas without Overpass.
Run on a network where Overpass works (e.g. your laptop):   python powerlines_preload.py
Power lines and buildings are public map data, so exact positions are fine to store.
"""
import json
import pathlib
import time

import requests

AREAS = [  # name, centre, radius (m): each covers the demo spots + 1 km around them
    ("RPI / Troy", 42.7302, -73.6788, 3500),
    ("Bolsa Chica", 33.700, -118.040, 4000),
]
MIRRORS = ["https://overpass-api.de/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter",
           "https://overpass.private.coffee/api/interpreter",
           "https://lz4.overpass-api.de/api/interpreter"]
UA = {"User-Agent": "NestGuard/1.0 (HackRPI 2026 student project)"}

out = []
for name, lat, lon, r in AREAS:
    q = (f'[out:json][timeout:60];'
         f'way(around:{r},{lat},{lon})["power"~"^(line|minor_line)$"];out geom;'
         f'way(around:{r},{lat},{lon})["building"];out center;')
    for url in MIRRORS:
        try:
            print(f"{name}: asking {url} ...")
            resp = requests.post(url, data={"data": q}, headers=UA, timeout=90)
            resp.raise_for_status()
            els = resp.json()["elements"]
            break
        except Exception as e:
            print("   failed:", e)
            time.sleep(2)
    else:
        raise SystemExit(f"All Overpass mirrors failed for {name}; try again in a minute.")
    lines = [{"coords": [[round(g["lat"], 6), round(g["lon"], 6)] for g in e["geometry"]],
              "kind": e.get("tags", {}).get("power", "line"), "voltage": e.get("tags", {}).get("voltage")}
             for e in els if e.get("geometry") and e.get("tags", {}).get("power")]
    buildings = [[round(e["center"]["lat"], 5), round(e["center"]["lon"], 5)] for e in els if e.get("center")]
    print(f"   {len(lines)} power lines, {len(buildings)} buildings")
    out.append({"name": name, "lat": lat, "lon": lon, "radius_m": r, "lines": lines, "buildings": buildings})
    time.sleep(3)                                        # be polite to Overpass

path = pathlib.Path(__file__).parent / "powerlines_preload.json"
path.write_text(json.dumps(out, separators=(",", ":")))
print(f"saved {path.name} ({path.stat().st_size // 1024} KB). Commit it and push.")
