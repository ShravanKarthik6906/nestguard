"""
NestGuard UNO Q - Linux side.
Gets raw readings from the sketch, converts them to deg C and light %, and
POSTs them to the backend every 10 s:  POST {API}/device/telemetry
  {"temp_c": 21.5, "light_pct": 40, "ts": "2026-11-07T14:05:00"}

Change API below to the backend address (Udaya's laptop now, Vultr later).
"""
import datetime
import json
import math
import time
import urllib.request

from arduino.app_utils import App, Bridge

API = "http://129.161.92.50:8000"     # <- change when the backend moves
SEND_EVERY_S = 10
ADC_MAX = 1023                        # matches analogReadResolution(10) in the sketch
THERMISTOR_B = 3975                   # Grove Temperature Sensor v1.0

latest = {"t_raw": None, "l_raw": None, "at": 0}
last_sent = 0


def on_readings(t_raw: int, l_raw: int):
    # Runs on the Bridge thread: only store values here (no Bridge calls).
    latest.update(t_raw=t_raw, l_raw=l_raw, at=time.time())


def temp_c(raw):
    if raw is None or raw <= 0 or raw >= ADC_MAX:
        return None                   # unplugged or shorted
    r = ADC_MAX / raw - 1             # thermistor / 10k ratio (Grove formula)
    return round(1 / (math.log(r) / THERMISTOR_B + 1 / 298.15) - 273.15, 1)


def light_pct(raw):
    return None if raw is None else round(raw / ADC_MAX * 100)


def post(body):
    req = urllib.request.Request(f"{API}/device/telemetry", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=4) as r:
        r.read()


def loop():
    global last_sent
    time.sleep(0.5)
    if time.time() - last_sent < SEND_EVERY_S:
        return
    last_sent = time.time()
    if time.time() - latest["at"] > 5:
        print("no readings from the sketch yet")
        return
    body = {"temp_c": temp_c(latest["t_raw"]), "light_pct": light_pct(latest["l_raw"]),
            "ts": datetime.datetime.now().isoformat(timespec="seconds")}
    try:
        post(body)
        print("sent", body)
    except Exception as e:
        print("backend unreachable:", e, body)


Bridge.provide("readings", on_readings)
App.run(user_loop=loop)
