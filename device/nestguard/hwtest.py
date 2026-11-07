#!/usr/bin/env python3
"""
One test per build step. Run on the Pi from inside the venv:
  python hwtest.py leds      Step 1
  python hwtest.py sensors   Step 2  (prints temp and light every second)
  python hwtest.py lcd       Step 3
  python hwtest.py gps       Step 4  (prints raw GPS text, then fixes)
  python hwtest.py motor     Step 5
Ctrl+C stops any test.
"""
import sys
import time

import nestguard as ng


def leds():
    from gpiozero import LED
    red, green = LED(ng.RED_PIN), LED(ng.GREEN_PIN)
    for name, r, g in [("red", 1, 0), ("green", 0, 1), ("both = yellow", 1, 1), ("off", 0, 0)]:
        print(name)
        red.value, green.value = r, g
        time.sleep(1.5)


def sensors():
    s = ng.Sensors()
    if not s.bus:
        sys.exit("ADC not found. Run: i2cdetect -y 1  (expect 48)")
    while True:
        t, l = s.read()
        print(f"A0 {s._volts(0):.3f} V -> {t} C    A1 {s._volts(1):.3f} V -> {l} % light")
        time.sleep(1)


def lcd():
    s = ng.Screen()
    if not s.lcd:
        sys.exit("LCD not found. Run: i2cdetect -y 1  (expect 27 or 3f), "
                 "then set NESTGUARD_LCD_ADDR=0x3f if needed")
    s.write("NestGuard ready", "LCD test OK")
    print("Text sent. Blank or boxes? Turn the blue screw on the back slowly.")


def gps():
    import serial
    import pynmea2
    ser = serial.Serial(ng.GPS_PORT, 9600, timeout=1)
    print("Raw text should stream below. Near a window, a fix can take 1-5 minutes.")
    while True:
        line = ser.readline().decode("ascii", errors="ignore").strip()
        if not line:
            print("(nothing - check GPS TX -> Pi pin 10 and that serial is enabled)")
            continue
        print(line)
        if line.startswith(("$GPGGA", "$GNGGA")):
            try:
                m = pynmea2.parse(line)
                if int(m.gps_qual or 0) > 0:
                    print(f"   >>> FIX: {m.latitude:.5f}, {m.longitude:.5f}  sats={m.num_sats}")
            except pynmea2.ParseError:
                pass


def motor():
    from gpiozero import PWMOutputDevice
    m = PWMOutputDevice(ng.MOTOR_PIN, frequency=200)
    for label, v in [("full", 1.0), ("off", 0), ("gentle (60%)", 0.6), ("off", 0)]:
        print(label)
        m.value = v
        time.sleep(1.5)


TESTS = {"leds": leds, "sensors": sensors, "lcd": lcd, "gps": gps, "motor": motor}

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in TESTS:
        sys.exit(__doc__)
    try:
        TESTS[sys.argv[1]]()
    except KeyboardInterrupt:
        pass
