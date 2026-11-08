"""
Tiger Data (TimescaleDB) = the WHEN of KnowFlyZone.   MongoDB Atlas = the WHERE.

Hypertables (time-partitioned):
  sightings  : time, cell_lat, cell_lon, spot, grp, n   - blurred ~1 km cells only, never exact points
  telemetry  : time, temp_c, light_pct                  - every reading the device sends
  checks     : time, cell_lat, cell_lon, level, score   - app checks, pilot position blurred to a cell

Everything here is optional and fail-safe: no TIGER_URL, or Tiger down -> functions return
None / [] and the rest of the API works exactly as before.
"""
import datetime
import os
import threading
import time

_conn = None
_lock = threading.Lock()
_cache = {}                       # small TTL cache so device polling doesn't hammer the DB
_down_until = 0                   # after a failure, skip Tiger for a minute (never slow the API)

SCHEMA = """
CREATE TABLE IF NOT EXISTS sightings (
  time timestamptz NOT NULL, cell_lat double precision NOT NULL, cell_lon double precision NOT NULL,
  spot text, grp text, n integer NOT NULL DEFAULT 1);
SELECT create_hypertable('sightings', by_range('time', INTERVAL '30 days'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS sightings_cell ON sightings (cell_lat, cell_lon, time DESC);

CREATE TABLE IF NOT EXISTS telemetry (
  time timestamptz NOT NULL, temp_c real, light_pct real);
SELECT create_hypertable('telemetry', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS checks (
  time timestamptz NOT NULL, cell_lat double precision, cell_lon double precision,
  level text, score integer);
SELECT create_hypertable('checks', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);
"""


def enabled():
    return bool(os.environ.get("TIGER_URL"))


def _connect():
    global _conn
    import psycopg
    if _conn is None or _conn.closed:
        _conn = psycopg.connect(os.environ["TIGER_URL"], autocommit=True, connect_timeout=3)
    return _conn


def run(sql, params=None, fetch=False):
    """One query, with a single reconnect on failure. Returns rows (fetch) or True; None on error."""
    global _conn, _down_until
    if not enabled() or time.time() < _down_until:
        return None
    with _lock:
        for attempt in range(2):
            try:
                cur = _connect().execute(sql, params or ())
                return cur.fetchall() if fetch else True
            except Exception as e:
                _conn = None
                if attempt == 1:
                    print("Tiger Data unavailable for 60 s:", e)
                    _down_until = time.time() + 60
    return None


def setup():
    """Create the hypertables (safe to run many times)."""
    return run(SCHEMA)


def cached(key, ttl, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = fn()
    _cache[key] = (time.time(), value)
    return value


# ------------------------------------------------------------------ writes
def log_telemetry(temp_c, light_pct):
    threading.Thread(target=run, daemon=True, args=(
        "INSERT INTO telemetry (time, temp_c, light_pct) VALUES (now(), %s, %s)",
        (temp_c, light_pct))).start()


def log_check(cell_lat, cell_lon, level, score):
    threading.Thread(target=run, daemon=True, args=(
        "INSERT INTO checks (time, cell_lat, cell_lon, level, score) VALUES (now(), %s, %s, %s, %s)",
        (cell_lat, cell_lon, level, score))).start()


# ------------------------------------------------------------------ reads
def trend(lat, lon, date, km=2.0):
    """Sightings in blurred cells within ~km of the point: last 14 days vs the 14 days before,
    relative to the check date. Returns {"recent", "before", "ratio", "weekly": [...]} or None."""
    def query():
        dlat, dlon = km / 111.0, km / 85.0
        end = datetime.datetime.combine(date, datetime.time(23, 59))
        rows = run("""
            SELECT time_bucket('7 days', time) AS week, sum(n)::int
            FROM sightings
            WHERE cell_lat BETWEEN %s AND %s AND cell_lon BETWEEN %s AND %s
              AND time > %s - INTERVAL '56 days' AND time <= %s
            GROUP BY week ORDER BY week""",
                   (lat - dlat, lat + dlat, lon - dlon, lon + dlon, end, end), fetch=True)
        if rows is None:
            return None
        weekly = [{"week": w.date().isoformat(), "sightings": n} for w, n in rows]
        cut = end - datetime.timedelta(days=14)
        recent = sum(n for w, n in rows if w.replace(tzinfo=None) > cut - datetime.timedelta(days=7))
        before = sum(n for w, n in rows
                     if cut - datetime.timedelta(days=21) < w.replace(tzinfo=None) <= cut - datetime.timedelta(days=7))
        ratio = round(recent / before, 1) if before else None
        return {"recent": recent, "before": before, "ratio": ratio, "weekly": weekly}
    return cached(("trend", round(lat, 2), round(lon, 2), date.isoformat()), 600, query)


def telemetry_history(minutes=60, bucket_s=60):
    rows = run("""
        SELECT time_bucket(make_interval(secs => %s), time) AS t,
               round(avg(temp_c)::numeric, 1)::float, round(avg(light_pct)::numeric)::float
        FROM telemetry WHERE time > now() - make_interval(mins => %s)
        GROUP BY t ORDER BY t""", (bucket_s, minutes), fetch=True)
    return [{"t": t.isoformat(timespec="seconds"), "temp_c": a, "light_pct": b} for t, a, b in rows or []]


def check_stats(hours=24):
    rows = run("""
        SELECT time_bucket('1 hour', time) AS h, count(*)::int, round(avg(score))::int, max(score)
        FROM checks WHERE time > now() - make_interval(hours => %s)
        GROUP BY h ORDER BY h""", (hours,), fetch=True)
    return [{"hour": h.isoformat(timespec="minutes"), "checks": n, "avg_risk": avg, "max_risk": mx}
            for h, n, avg, mx in rows or []]
