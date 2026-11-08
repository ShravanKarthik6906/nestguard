#!/usr/bin/env python3
"""
NestGuard on the Jetson Orin Nano alone (no Arduino): the Jetson is the brain AND drives the parts.

Same logic as nestguard.py (backend checks, demo mode, offline zones, telemetry). The LEDs, LCD,
temperature sensor and camera stepper are driven by nestguard_hw.py straight from the 40-pin header
(wiring is in nestguard_hw.py). Risk score -> LEDs: 60+ red, 30+ yellow, else green; LCD "RISK 82".

Setup once:   venv/bin/pip install smbus2 Jetson.GPIO
Run:          sudo venv/bin/python jetson_direct.py
"""
import threading
import time

import nestguard as ng
from nestguard_hw import NestGuard

WORD = {"green": "GREEN", "yellow": "YELLOW", "red": "RED"}
HW = None
STATE = {"level": "unknown", "text": "Waiting for GPS"}


def heartbeat():
    """nestguard_hw shows NO LINK after 5 s without set_state(), so send the state every second.
    unknown (no position yet) shows as YELLOW so it doesn't fall into NO LINK while we wait."""
    while True:
        try:
            HW.set_state(WORD.get(STATE["level"], "YELLOW"), STATE["text"][:16])
        except Exception as e:
            ng.log("[hw] set_state failed:", e)
        time.sleep(1)


# ---- stand-ins for the parts nestguard.py would drive itself: they feed nestguard_hw instead
class HwLights:
    def __init__(self):
        pass

    def show(self, level):
        if level != "off":
            STATE["level"] = level


class HwScreen:
    lcd = None                        # nestguard_hw owns the LCD (line 2 = its sensor readings)

    def __init__(self):
        pass

    def write(self, line1, line2=""):
        STATE["text"] = line1         # e.g. "RISK 82" -> top LCD line

    def flash(self, times=3):
        pass


class HwSensors:
    def __init__(self):
        self.bus = None

    def read(self):
        r = HW.read_sensors()
        return r.get("temp"), None    # (temp C, light %): this build has no light sensor


class NoMotor:
    def __init__(self):
        self.m = None

    def gentle(self):
        pass

    def strong(self):
        pass

    def tick(self):
        pass


class NoGPS:
    """No GPS in this build: the app's demo mode gives the position."""

    def __init__(self):
        pass

    def position(self):
        return None


def main():
    global HW
    HW = NestGuard()
    ng.log("[hw] found:", HW.info())
    threading.Thread(target=heartbeat, daemon=True).start()
    ng.Lights, ng.Screen, ng.Sensors, ng.Motor, ng.GPS = HwLights, HwScreen, HwSensors, NoMotor, NoGPS
    ng.log(f"NestGuard (Jetson only). Backend: {ng.API}")
    dev = ng.Device()
    server = ng.ThreadingHTTPServer(("0.0.0.0", ng.PORT), ng.make_handler(dev))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        dev.run()
    except KeyboardInterrupt:
        ng.log("stopped")
    finally:
        HW.close()


if __name__ == "__main__":
    main()
