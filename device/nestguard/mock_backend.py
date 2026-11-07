#!/usr/bin/env python3
"""
Stand-in for the real backend so the device can be tested before Udaya's API
is live. Run it on a laptop (or the Pi itself):
  python3 mock_backend.py            -> serves on port 8000
Then point the Pi at it: NESTGUARD_API=http://<laptop-ip>:8000

Endpoints match what the device calls:
  GET  /check?lat=..&lon=..&date=..   handoff message (red near RPI's test zone)
  GET  /device/demo                   demo location, or {} when demo is off
  POST /device/demo                   {"lat":..,"lon":..} to set, {} to clear
  POST /device/telemetry              prints temp/light from the device
"""
import json
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ZONE = {"lat": 42.73, "lon": -73.68, "radius_m": 200, "level": "red"}
demo = {}


def dist(a, b, c, d):
    p1, p2 = math.radians(a), math.radians(c)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(d - b) / 2) ** 2
    return 12742000 * math.asin(math.sqrt(h))


class H(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/check":
            q = parse_qs(u.query)
            lat, lon = float(q["lat"][0]), float(q["lon"][0])
            d = dist(lat, lon, ZONE["lat"], ZONE["lon"])
            if d < 200:
                msg = {"level": "red", "score": 82, "message": "Nesting zone, climb to 300 ft",
                       "reasons": ["Hawk sightings within 1 km", "Nesting season"]}
            elif d < 1000:
                msg = {"level": "yellow", "score": 55, "message": "Birds nearby, keep 100 m away",
                       "reasons": ["Recent sightings"]}
            else:
                msg = {"level": "green", "score": 12, "message": "Clear to fly", "reasons": []}
            msg["zones"] = [ZONE]
            return self._send(msg)
        if u.path == "/device/demo":
            return self._send(demo)
        self._send({"error": "not found"}, 404)

    def do_POST(self):
        global demo
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path == "/device/demo":
            demo = body
            return self._send({"ok": True, "demo": demo})
        if self.path == "/device/telemetry":
            print("telemetry:", body)
            return self._send({"ok": True})
        self._send({"error": "not found"}, 404)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print("mock backend on :8000")
    ThreadingHTTPServer(("0.0.0.0", 8000), H).serve_forever()
