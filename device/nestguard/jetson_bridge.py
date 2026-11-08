#!/usr/bin/env python3
"""
NestGuard on Jetson + UNO Q (option B): the Jetson is the brain, the UNO Q drives the parts.

Same logic as nestguard.py (backend checks, demo mode, offline zones, telemetry), but instead of
driving LEDs/LCD itself, it talks to Ryan's UNO Q sketch over the UART (115200 baud):
  Jetson -> UNO Q   STATE,GREEN|YELLOW|RED,<message>   every second
  UNO Q -> Jetson   S,temp=21.4,hum=45.0,air=812,light=1530,pan=0.0   every second
                    INFO,...  (logged)       anything else is ignored (e.g. Zephyr boot text)

Wiring (3.3 V logic on both boards):
  Jetson pin 8  (UART TX)  ->  UNO Q D0 (RX)
  Jetson pin 10 (UART RX)  <-  UNO Q D1 (TX)
  Jetson pin 6  (GND)      ->  UNO Q GND

Run:  sudo venv/bin/python jetson_bridge.py
Port: auto (/dev/ttyTHS0 or ttyTHS1 on a Jetson); override with NESTGUARD_UNOQ_PORT=/dev/...
"""
import os
import threading
import time

import nestguard as ng

PORT = os.environ.get("NESTGUARD_UNOQ_PORT") or ng.GPS_PORT
BAUD = 115200
ADC_MAX = 16383                      # Ryan's sketch reads analog at 14 bits
WORD = {"green": "GREEN", "yellow": "YELLOW", "red": "RED"}


class Link:
    """Serial link to the UNO Q: sends STATE once a second, parses S lines."""

    def __init__(self):
        self.level, self.text = "unknown", "Waiting for GPS"
        self.temp = self.light = self.air = None
        self.last_rx = 0
        self.ser = None
        try:
            import serial
            self.ser = serial.Serial(PORT, BAUD, timeout=1)
            ng.log(f"[link] UNO Q on {PORT} at {BAUD}")
            threading.Thread(target=self._rx, daemon=True).start()
            threading.Thread(target=self._tx, daemon=True).start()
        except Exception as e:
            ng.log("[link] disabled:", e)

    def _tx(self):
        while True:
            # unknown (no position yet) is shown as a cautious YELLOW so the UNO Q doesn't
            # fall into its NO LINK state while we wait for GPS or a demo location
            word = WORD.get(self.level, "YELLOW")
            msg = self.text.replace(",", " ").replace("\n", " ")[:40]
            try:
                self.ser.write(f"STATE,{word},{msg}\n".encode())
            except Exception as e:
                ng.log("[link] write failed:", e)
            time.sleep(1)

    def _rx(self):
        buf = b""
        while True:
            try:
                buf += self.ser.read(256)
            except Exception:
                time.sleep(0.5)
                continue
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode("ascii", errors="ignore").strip()
                if line.startswith("S,"):
                    self._parse(line)
                elif line.startswith("INFO,") or line.startswith("MOVED,"):
                    ng.log("[unoq]", line)

    def _parse(self, line):
        vals = {}
        for part in line.split(",")[1:]:
            if "=" in part:
                k, v = part.split("=", 1)
                try:
                    vals[k] = float(v)
                except ValueError:
                    pass
        self.temp = round(vals["temp"], 1) if "temp" in vals else None
        self.light = round(vals["light"] / ADC_MAX * 100) if "light" in vals else None
        self.air = round(vals["air"] / ADC_MAX * 100) if "air" in vals else None
        self.last_rx = time.time()


LINK = None


# ---- stand-ins for the parts nestguard.py would drive itself: they feed the link instead
class LinkLights:
    def __init__(self):
        pass

    def show(self, level):
        if LINK and level != "off":
            LINK.level = level


class LinkScreen:
    lcd = None                        # nothing to flash here; the UNO Q handles its own LCD

    def __init__(self):
        pass

    def write(self, line1, line2=""):
        if LINK:
            LINK.text = line1         # e.g. "RISK 98" -> the UNO Q's top LCD line

    def flash(self, times=3):
        pass


class LinkSensors:
    def __init__(self):
        self.bus = None

    def read(self):
        if LINK and time.time() - LINK.last_rx < 5:
            return LINK.temp, LINK.light
        return None, None


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
    """The GPS isn't wired in this build (the UART is used for the UNO Q). Demo mode gives the position."""

    def __init__(self):
        pass

    def position(self):
        return None


def main():
    global LINK
    LINK = Link()
    ng.Lights, ng.Screen, ng.Sensors, ng.Motor, ng.GPS = LinkLights, LinkScreen, LinkSensors, NoMotor, NoGPS
    ng.log(f"NestGuard bridge (Jetson brain + UNO Q). Backend: {ng.API}")
    dev = ng.Device()
    server = ng.ThreadingHTTPServer(("0.0.0.0", ng.PORT), ng.make_handler(dev))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        dev.run()
    except KeyboardInterrupt:
        ng.log("stopped")


if __name__ == "__main__":
    main()
