#!/usr/bin/env python3
"""
NestGuard device - Raspberry Pi 4 edition.

What it does, every few seconds:
  1. Gets the pilot's position (GPS, or a demo location the app sends).
  2. Asks the NestGuard backend for the handoff message at that position.
  3. Also checks the saved zones itself, so it still works if Wi-Fi drops.
  4. Shows the result: LEDs, LCD text, and a buzz.
  5. Sends temperature and light readings to the backend.

Every hardware part is optional. If one is not wired or fails, the program
prints "[part] disabled" and keeps running with the rest.

Local HTTP API on port 8080 (for a laptop app or curl):
  GET  /status            current level, sensor readings, GPS fix
  POST /handoff           push a handoff message straight to the device
  POST /demo              {"lat": 42.73, "lon": -73.68, "date": "2021-05-13"} to fake a
                          position (date optional), {} to clear
"""
import datetime
import json
import math
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------- settings
# Override any of these with environment variables (see nestguard.service).
API = os.environ.get("NESTGUARD_API", "https://149-28-239-148.sslip.io").rstrip("/")
CHECK_PATH = os.environ.get("NESTGUARD_CHECK_PATH", "/check")      # match the README
DEMO_PATH = os.environ.get("NESTGUARD_DEMO_PATH", "/device/demo")
TELEMETRY_PATH = os.environ.get("NESTGUARD_TELEMETRY_PATH", "/device/telemetry")
POLL_S = float(os.environ.get("NESTGUARD_POLL_S", "5"))
TELEMETRY_S = 10
YELLOW_BUFFER_M = 100          # yellow when within 100 m of a zone edge
PUSH_HOLD_S = 60               # a pushed handoff wins over polling for 60 s
PORT = int(os.environ.get("NESTGUARD_PORT", "8080"))

# BCM GPIO numbers. Defaults = physical pins 11, 13, 12. If the LEDs are in Grove HAT
# sockets instead, use that socket's number (D5 -> 5, D16 -> 16, D22 -> 22, ...).
RED_PIN = int(os.environ.get("NESTGUARD_RED_PIN", "17"))
GREEN_PIN = int(os.environ.get("NESTGUARD_GREEN_PIN", "27"))
MOTOR_PIN = int(os.environ.get("NESTGUARD_MOTOR_PIN", "18"))
# Analog channels: Grove Base HAT socket A0 -> 0, A2 -> 2 (ADS1115 board: A0 -> 0, A1 -> 1)
TEMP_CH = int(os.environ.get("NESTGUARD_TEMP_CH", "0"))
LIGHT_CH = int(os.environ.get("NESTGUARD_LIGHT_CH", "2"))
def _is_jetson():
    try:
        return os.path.exists("/etc/nv_tegra_release") or \
            "nvidia" in open("/proc/device-tree/model").read().lower()
    except OSError:
        return False


JETSON = _is_jetson()
# Pins 3/5 are I2C bus 1 on a Pi, bus 7 on a Jetson Orin Nano
I2C_BUS = int(os.environ.get("NESTGUARD_I2C_BUS", "7" if JETSON else "1"))
LCD_ADDR = int(os.environ.get("NESTGUARD_LCD_ADDR", "0x27"), 16)
ADC_ADDR = int(os.environ.get("NESTGUARD_ADC_ADDR", "0x48"), 16)
def _gps_port():
    if os.environ.get("NESTGUARD_GPS_PORT"):
        return os.environ["NESTGUARD_GPS_PORT"]
    # header pins 8/10: Pi -> /dev/serial0; Jetson Orin -> ttyTHS0 (JetPack 5/6) or ttyTHS1 (JetPack 7)
    for p in (["/dev/ttyTHS0", "/dev/ttyTHS1"] if JETSON else ["/dev/serial0"]):
        if os.path.exists(p):
            return p
    return "/dev/serial0"


GPS_PORT = _gps_port()
VCC = 3.3                      # what the Grove sensors are powered from
THERMISTOR_B = 3975            # Grove Temperature Sensor v1.0

HERE = os.path.dirname(os.path.abspath(__file__))
ZONE_CACHE = os.path.join(HERE, "zones_cache.json")

LEVEL_RANK = {"unknown": -1, "green": 0, "yellow": 1, "red": 2}
LABEL = {"green": "RISK LOW", "yellow": "RISK MED", "red": "RISK HIGH", "unknown": "NO DATA"}


def band(score):
    """Risk score 0-100 -> LED band (same cut-offs as the backend: 60 / 30)."""
    try:
        s = float(score)
    except (TypeError, ValueError):
        return "unknown"
    return "red" if s >= 60 else "yellow" if s >= 30 else "green"


def msg_level(msg):
    """The API now sends only a score; older backends sent a level."""
    if msg.get("level") in ("green", "yellow", "red"):
        return msg["level"]
    return band(msg.get("score"))


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- hardware
# BCM GPIO number -> physical header pin (for Jetson.GPIO, which uses BOARD numbering)
BCM_TO_BOARD = {4: 7, 17: 11, 18: 12, 27: 13, 22: 15, 23: 16, 24: 18, 25: 22, 5: 29, 6: 31,
                12: 32, 13: 33, 19: 35, 16: 36, 26: 37, 20: 38, 21: 40}


class _JetsonLED:
    """Tiny stand-in for gpiozero.LED on a Jetson (on / off / blink)."""
    def __init__(self, bcm):
        import Jetson.GPIO as GPIO
        self.GPIO, self.pin = GPIO, BCM_TO_BOARD[bcm]
        GPIO.setwarnings(False)
        GPIO.setmode(GPIO.BOARD)
        GPIO.setup(self.pin, GPIO.OUT, initial=GPIO.LOW)
        self._blink = None

    def _set(self, v):
        self.GPIO.output(self.pin, self.GPIO.HIGH if v else self.GPIO.LOW)

    def on(self):
        self._blink = None
        self._set(1)

    def off(self):
        self._blink = None
        self._set(0)

    @property
    def value(self):
        return self.GPIO.input(self.pin)

    @value.setter
    def value(self, v):
        self.on() if v else self.off()

    def blink(self, on_s, off_s):
        token = object()
        self._blink = token

        def run():
            while self._blink is token:
                self._set(1)
                time.sleep(on_s)
                if self._blink is not token:
                    break
                self._set(0)
                time.sleep(off_s)
        threading.Thread(target=run, daemon=True).start()


def make_led(bcm):
    if JETSON:
        return _JetsonLED(bcm)
    from gpiozero import LED
    return LED(bcm)


class Lights:
    def __init__(self):
        self.red = self.green = None
        try:
            self.red, self.green = make_led(RED_PIN), make_led(GREEN_PIN)
        except Exception as e:
            log("[lights] disabled:", e)

    def show(self, level):
        if not self.red:
            return
        self.red.off()
        self.green.off()
        if level == "green":
            self.green.on()
        elif level == "yellow":
            self.red.on()
            self.green.on()
        elif level == "red":
            self.red.blink(0.3, 0.3)
        elif level == "off":
            pass
        else:                                   # unknown: slow green heartbeat
            self.green.blink(0.1, 1.9)


class Motor:
    def __init__(self):
        self.m = None
        self.lock = threading.Lock()
        if JETSON or os.environ.get("NESTGUARD_NO_MOTOR"):
            return                              # no motor in this build (no transistor)
        try:
            from gpiozero import PWMOutputDevice
            self.m = PWMOutputDevice(MOTOR_PIN, frequency=200)
        except Exception as e:
            log("[motor] disabled:", e)

    def _play(self, steps):
        if not self.m:
            return

        def run():
            with self.lock:
                for strength, seconds in steps:
                    self.m.value = strength
                    time.sleep(seconds)
                self.m.value = 0
        threading.Thread(target=run, daemon=True).start()

    def gentle(self):
        self._play([(0.6, 0.25), (0, 0.25), (0.6, 0.25)])

    def strong(self):
        self._play([(1, 0.6), (0, 0.2), (1, 0.6), (0, 0.2), (1, 0.6)])

    def tick(self):
        self._play([(0.6, 0.1)])


class Screen:
    def __init__(self):
        self.lcd = None
        self.lock = threading.Lock()
        try:
            from RPLCD.i2c import CharLCD
            self.lcd = CharLCD("PCF8574", LCD_ADDR, port=I2C_BUS, cols=16, rows=2)
            self.lcd.clear()
        except Exception as e:
            log("[lcd] disabled:", e)

    def write(self, line1, line2=""):
        if not self.lcd:
            return
        with self.lock:
            try:
                self.lcd.cursor_pos = (0, 0)
                self.lcd.write_string(line1[:16].ljust(16))
                self.lcd.cursor_pos = (1, 0)
                self.lcd.write_string(line2[:16].ljust(16))
            except Exception as e:
                log("[lcd] write failed:", e)


    def flash(self, times=3):
        """Blink the backlight - the visual alert when there is no motor."""
        if not self.lcd:
            return

        def run():
            try:
                for _ in range(times):
                    for on in (False, True):
                        with self.lock:
                            self.lcd.backlight_enabled = on
                        time.sleep(0.25)
            except Exception:
                pass
        threading.Thread(target=run, daemon=True).start()


class Sensors:
    """Grove temperature + light sensors. Tries, in order:
       1. Grove Base HAT's built-in ADC (I2C 0x04 = STM32 version, 0x08 = MM32 version)
       2. an ADS1115 board (I2C 0x48)
    Each read returns a 0-1 ratio of the 3.3 V supply."""

    def __init__(self):
        self.bus = self.kind = None
        try:
            from smbus2 import SMBus
            self.bus = SMBus(I2C_BUS)
        except Exception as e:
            log("[sensors] disabled:", e)
            return
        for addr in (0x04, 0x08):
            try:
                self.addr = addr
                self.kind = "hat"
                self._ratio(TEMP_CH)
                log(f"[sensors] Grove Base HAT ADC at {hex(addr)}")
                return
            except Exception:
                pass
        try:
            self.addr, self.kind = ADC_ADDR, "ads1115"
            self._ratio(TEMP_CH)
            log(f"[sensors] ADS1115 at {hex(ADC_ADDR)}")
            return
        except Exception as e:
            log("[sensors] disabled: no Grove HAT or ADS1115 found", e)
        self.bus = self.kind = None

    def _ratio(self, channel):
        if self.kind == "hat":
            reg = 0x10 + channel                     # raw 12-bit value (Seeed grove.py adc.py)
            self.bus.write_byte(self.addr, reg)
            raw = self.bus.read_word_data(self.addr, reg)
            return raw / 4095
        # ADS1115: single-shot, AINx vs GND, +/-4.096 V, 128 SPS, comparator off
        config = 0x8000 | ((0x4 + channel) << 12) | 0x0200 | 0x0100 | 0x0080 | 0x0003
        self.bus.write_i2c_block_data(self.addr, 0x01, [config >> 8, config & 0xFF])
        time.sleep(0.01)
        hi, lo = self.bus.read_i2c_block_data(self.addr, 0x00, 2)
        raw = (hi << 8) | lo
        if raw > 0x7FFF:
            raw -= 0x10000
        return max(raw, 0) * 4.096 / 32768 / VCC

    def _volts(self, channel):                       # used by hwtest.py
        return self._ratio(channel) * VCC

    def read(self):
        """Returns (temp_c, light_pct); either can be None."""
        if not self.bus:
            return None, None
        try:
            ratio = self._ratio(TEMP_CH)
            temp = None
            if 0.01 < ratio < 0.99:
                temp = 1 / (math.log(1 / ratio - 1) / THERMISTOR_B + 1 / 298.15) - 273.15
            light = min(100.0, self._ratio(LIGHT_CH) * 100)
            return (round(temp, 1) if temp is not None else None), round(light)
        except Exception as e:
            log("[sensors] read failed:", e)
            return None, None


class GPS:
    def __init__(self):
        self.lat = self.lon = None
        self.when = 0
        try:
            import serial      # pyserial
            import pynmea2
            self.ser = serial.Serial(GPS_PORT, 9600, timeout=1)
            self.pynmea2 = pynmea2
            threading.Thread(target=self._run, daemon=True).start()
        except Exception as e:
            log("[gps] disabled:", e)

    def _run(self):
        while True:
            try:
                line = self.ser.readline().decode("ascii", errors="ignore").strip()
                if not line.startswith("$"):
                    continue
                msg = self.pynmea2.parse(line)
                kind = msg.sentence_type
                ok = (kind == "GGA" and int(msg.gps_qual or 0) > 0) or \
                     (kind == "RMC" and msg.status == "A")
                if ok and msg.latitude and msg.longitude:
                    self.lat, self.lon, self.when = msg.latitude, msg.longitude, time.time()
            except Exception:
                time.sleep(0.1)

    def position(self):
        if self.lat is not None and time.time() - self.when < 10:
            return self.lat, self.lon
        return None


# ---------------------------------------------------------------- logic
def distance_m(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def zone_level(pos, zones):
    """Red inside a zone, yellow within YELLOW_BUFFER_M of its edge."""
    worst = "green" if zones else "unknown"
    for z in zones:
        try:
            d = distance_m(pos[0], pos[1], float(z["lat"]), float(z["lon"]))
            radius = float(z.get("radius_m", 200))
        except (KeyError, TypeError, ValueError):
            continue
        if d <= radius:
            here = band(z["risk"]) if "risk" in z else z.get("level", "red")
            here = here if here in LEVEL_RANK and here != "unknown" else "red"
        elif d <= radius + YELLOW_BUFFER_M:
            here = "yellow"
        else:
            continue
        if LEVEL_RANK[here] > LEVEL_RANK[worst]:
            worst = here
    return worst


def http_json(method, url, body=None, timeout=4):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        text = r.read().decode() or "null"
        return json.loads(text)


class Device:
    def __init__(self):
        self.lights, self.motor, self.screen = Lights(), Motor(), Screen()
        self.sensors, self.gps = Sensors(), GPS()
        self.lock = threading.Lock()
        self.handoff = None
        self.pushed_at = 0
        self.demo = None
        self.demo_date = None                        # demo can replay a past day (Bolsa Chica)
        self.local_demo = False                      # demo set through this Pi's /demo
        self.online = False
        self.level = None
        self.last_red_buzz = 0
        self.temp = self.light = None
        self.ticker = ""
        self.headline = "KnowFlyZone"
        self.zones = self._load_zones()
        self.screen.write("KnowFlyZone", "Waiting for data")
        self.lights.show("unknown")
        threading.Thread(target=self._ticker_loop, daemon=True).start()

    # zones are cached on the SD card so the offline check works after a reboot
    def _load_zones(self):
        try:
            with open(ZONE_CACHE) as f:
                return json.load(f)
        except Exception:
            return []

    def _save_zones(self, zones):
        self.zones = zones
        try:
            with open(ZONE_CACHE, "w") as f:
                json.dump(zones, f)
        except Exception as e:
            log("[zones] could not save cache:", e)

    def take_handoff(self, msg, pushed=False):
        if not isinstance(msg, dict) or ("level" not in msg and "score" not in msg):
            raise ValueError("handoff needs at least a 'score' field")
        with self.lock:
            self.handoff = msg
            if pushed:
                self.pushed_at = time.time()
            if isinstance(msg.get("zones"), list):
                self._save_zones(msg["zones"])

    def position(self):
        return self.demo or self.gps.position()

    # -- talking to the backend
    def poll_backend(self, pos):
        if time.time() - self.pushed_at < PUSH_HOLD_S:
            return                                   # app pushed one recently
        day = (self.demo_date if self.demo and self.demo_date
               else datetime.date.today().isoformat())
        q = urllib.parse.urlencode({"lat": pos[0], "lon": pos[1], "date": day})
        try:
            self.take_handoff(http_json("GET", f"{API}{CHECK_PATH}?{q}"))
            if not self.online:
                log("[api] online")
            self.online = True
        except Exception as e:
            if self.online:
                log("[api] offline, using saved zones:", e)
            self.online = False

    def poll_demo(self):
        try:
            d = http_json("GET", f"{API}{DEMO_PATH}", timeout=2)
            if isinstance(d, dict) and "lat" in d and "lon" in d:
                self.demo = (float(d["lat"]), float(d["lon"]))
                self.demo_date = d.get("date")
            elif not self.local_demo:
                if self.demo is not None:
                    self.handoff = None              # demo ended: forget the demo's answer
                self.demo, self.demo_date = None, None   # backend says demo is off
        except Exception:
            pass                                     # endpoint optional

    def send_telemetry(self):
        # The Jetson has no working sensor, so temp and light are often None. Send anyway:
        # this check-in (with a fresh ts) is how the app knows the device is online.
        try:
            http_json("POST", f"{API}{TELEMETRY_PATH}",
                      {"temp_c": self.temp, "light_pct": self.light,
                       "ts": datetime.datetime.now().isoformat(timespec="seconds")},
                      timeout=3)
        except Exception:
            pass

    # -- deciding and showing
    def decide(self):
        pos = self.position()
        msg = self.handoff or {}
        api_level = msg_level(msg)
        local = zone_level(pos, self.zones) if pos else "unknown"
        level = max(api_level, local, key=lambda l: LEVEL_RANK[l])
        if pos is None and not msg:
            return "unknown", "Waiting for GPS", ""
        score = msg.get("score")
        head = f"RISK {score}" if score is not None and level == api_level else LABEL[level]
        parts = []
        if local != "unknown" and LEVEL_RANK[local] > LEVEL_RANK[api_level]:
            parts.append("Near a nesting zone" if local == "yellow" else "Inside a nesting zone")
        if msg.get("message"):
            parts.append(str(msg["message"]))
        parts += [str(r) for r in msg.get("reasons", [])]
        if self.temp is not None:
            parts.append(f"{self.temp:.0f}C")
        if not self.online and not (time.time() - self.pushed_at < PUSH_HOLD_S):
            parts.append("offline")
        if pos is None:
            parts.append("no GPS fix")
        return level, head, " | ".join(parts)

    def show(self, level, head, text):
        changed = level != self.level
        if changed:
            log(f"[level] {self.level} -> {level}: {head} | {text}")
            self.lights.show(level)
            if level == "red":
                self.motor.strong()
                self.screen.flash(5)
                self.last_red_buzz = time.time()
            elif level == "yellow":
                self.motor.gentle()
                self.screen.flash(2)
            elif level == "green" and self.level in ("yellow", "red"):
                self.motor.tick()
            self.level = level
        elif level == "red" and time.time() - self.last_red_buzz > 15:
            self.motor.strong()                      # keep nagging while inside red
            self.screen.flash(3)
            self.last_red_buzz = time.time()
        self.headline, self.ticker = head, text

    def _ticker_loop(self):
        i = 0
        while True:
            text = self.ticker
            if len(text) <= 16:
                self.screen.write(self.headline, text)
                i = 0
            else:
                padded = text + "   "
                self.screen.write(self.headline, (padded * 2)[i:i + 16])
                i = (i + 2) % len(padded)
            time.sleep(0.6)

    def status(self):
        pos = self.position()
        return {"level": self.level, "headline": self.headline, "text": self.ticker,
                "temp_c": self.temp, "light_pct": self.light,
                "gps_fix": self.gps.position() is not None,
                "demo_mode": self.demo is not None,
                "online": self.online, "zones_saved": len(self.zones),
                "has_position": pos is not None}

    def run(self):
        last_poll = last_tel = 0
        while True:
            now = time.time()
            self.temp, self.light = self.sensors.read()
            if now - last_poll >= POLL_S:
                last_poll = now
                self.poll_demo()
                pos = self.position()
                if pos:
                    self.poll_backend(pos)
            if now - last_tel >= TELEMETRY_S:
                last_tel = now
                self.send_telemetry()
            self.show(*self.decide())
            time.sleep(0.5)


# ---------------------------------------------------------------- local API
def make_handler(dev):
    class H(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self._send(204, {})

        def do_GET(self):
            if self.path.startswith("/status"):
                self._send(200, dev.status())
            else:
                self._send(404, {"error": "try /status"})

        def do_POST(self):
            try:
                n = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(n) or b"{}")
                if self.path.startswith("/handoff"):
                    dev.take_handoff(body, pushed=True)
                elif self.path.startswith("/demo"):
                    if "lat" in body and "lon" in body:
                        dev.demo = (float(body["lat"]), float(body["lon"]))
                        dev.demo_date = body.get("date")
                        dev.local_demo = True
                    else:
                        dev.demo, dev.local_demo = None, False
                else:
                    return self._send(404, {"error": "use /handoff or /demo"})
                self._send(200, {"ok": True, **dev.status()})
            except Exception as e:
                self._send(400, {"error": str(e)})

        def log_message(self, *a):
            pass
    return H


def main():
    log(f"KnowFlyZone starting on {'Jetson' if JETSON else 'Raspberry Pi'}. Backend: {API}{CHECK_PATH}  "
        f"I2C bus {I2C_BUS}, GPS {GPS_PORT}, local API port {PORT}")
    dev = Device()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), make_handler(dev))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        dev.run()
    except KeyboardInterrupt:
        dev.screen.write("KnowFlyZone", "stopped")
        dev.lights.show("off")
        log("stopped")


if __name__ == "__main__":
    main()
