#!/usr/bin/env python3
"""
Load the raw sightings in data/ into Tiger Data as a time series of BLURRED cells.
Exact coordinates are snapped to the ~1 km grid before anything is sent.

  pip install "psycopg[binary]" python-dotenv
  python tiger_seed.py            (backend/.env must have TIGER_URL=postgres://...)
"""
import pathlib
import sys

from dotenv import load_dotenv

HERE = pathlib.Path(__file__).parent
load_dotenv(HERE / ".env")

import scoring                                      # noqa: E402  (group_of)
import seed_zones                                   # noqa: E402  (loaders + snap, same grid as Atlas)
import tiger                                        # noqa: E402

if not tiger.enabled():
    sys.exit("TIGER_URL missing from backend/.env")
if not tiger.setup():
    sys.exit("Could not create the Tiger Data tables - check TIGER_URL")

rows = []
for name, spot, loader in [("rpi_ebird_recent.json", "rpi", seed_zones.ebird_sightings),
                           ("bolsa_ebird_2021-05-13.json", "bolsa", seed_zones.ebird_sightings),
                           ("rpi_inat.json", "rpi", seed_zones.inat_sightings),
                           ("bolsa_inat_may2021.json", "bolsa", seed_zones.inat_sightings)]:
    for s in loader(seed_zones.load(name), spot):
        if not s["date"]:
            continue
        clat, clon = seed_zones.snap(s["lat"], s["lon"])          # blur first, always
        n = s["count"] if isinstance(s["count"], int) else 1      # eBird uses "X" for present
        rows.append((s["date"] + "T12:00:00Z", clat, clon, spot, scoring.group_of(s["name"]), max(1, n)))

tiger.run("TRUNCATE sightings")
for i in range(0, len(rows), 500):
    import psycopg  # noqa: F401  (already used by tiger)
    with tiger._lock:
        conn = tiger._connect()
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO sightings (time, cell_lat, cell_lon, spot, grp, n) "
                            "VALUES (%s, %s, %s, %s, %s, %s)", rows[i:i + 500])
print(f"loaded {len(rows)} blurred sightings into Tiger Data (hypertable 'sightings')")
print(tiger.run("SELECT spot, count(*), min(time)::date, max(time)::date FROM sightings GROUP BY spot",
                fetch=True))
