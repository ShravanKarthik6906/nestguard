#!/usr/bin/env python3
"""
Find demo spots in Troy right next to a mapped power line (for a red "power line" scenario).
Uses powerlines_preload.json, so it needs no internet.   python find_demo_spot.py
Prints the 5 line points closest to RPI and a spot 40 m beside each, already checked.
"""
import json
import math
import pathlib

import hazards as hz

RPI = (42.7302, -73.6788)
areas = json.loads((pathlib.Path(__file__).parent / "powerlines_preload.json").read_text())
troy = next(a for a in areas if a["name"].startswith("RPI"))

pts = []
for line in troy["lines"]:
    for lat, lon in line["coords"]:
        d = hz.nearest_line_m(RPI[0], RPI[1], [{"coords": [[lat, lon], [lat, lon]]}])
        pts.append((d, lat, lon, line.get("kind"), line.get("voltage")))
pts.sort()

seen, shown = [], 0
for d, lat, lon, kind, volt in pts:
    if any(abs(lat - a) < 0.002 and abs(lon - b) < 0.002 for a, b in seen):
        continue                                              # skip points on the same stretch
    seen.append((lat, lon))
    spot = (round(lat + 40 / 110540, 5), lon)                 # 40 m north of the line point
    area = hz.osm_area(*spot)
    dist = hz.nearest_line_m(spot[0], spot[1], area["lines"])
    covered = "preloaded" in area.get("source", "")
    print(f"{shown + 1}. spot {spot[0]}, {spot[1]}  ->  line {dist:.0f} m away "
          f"({'RED' if dist <= 100 else 'yellow' if dist <= 300 else 'green'}), "
          f"{d / 1000:.1f} km from RPI, {kind} {volt or ''} V, {'offline-safe' if covered else 'needs Overpass'}")
    shown += 1
    if shown == 5:
        break
print("\nPick one marked RED + offline-safe for Dhruv's scenario button.")
