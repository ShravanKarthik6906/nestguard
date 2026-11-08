#!/usr/bin/env python3
"""
NestGuard hardware driver: Jetson Orin Nano only (no Arduino)

Drives the 3 alert LEDs, the camera pan stepper (IN1-IN4 driver board),
the 16x2 I2C LCD and the I2C temperature sensor, straight from the 40-pin header.

WIRING (physical pin numbers on the 40-pin header)
  I2C (LCD + temperature sensor share these):
    SDA -> pin 3      SCL -> pin 5      VCC -> pin 1 (3.3 V)      GND -> pin 9
  LEDs (each: pin -> resistor -> long leg ... short leg -> GND):
    Red    -> pin 7       Green  -> pin 15      GND -> pin 14
    (two LEDs: low risk = green, medium = green + red, high = red; the LCD always shows the score)
  Stepper driver board:
    IN1 -> pin 29   IN2 -> pin 31   IN3 -> pin 32   IN4 -> pin 33
    VCC -> pin 2 (5 V)   GND -> pin 30

USE FROM THE SIMULATION
  from nestguard_hw import NestGuard
  ng = NestGuard()                          # finds the LCD and sensor, starts the safety watchdog
  ng.set_state("GREEN", "Clear to fly")     # call at least once per second (GREEN / YELLOW / RED)
  ng.pan_to(90)                             # waits until the camera stops: safe to take a photo
  r = ng.read_sensors()                     # {'temp': 22.1, 'hum': 40.2, 'pres': None, 'pan': 90.0}
  ng.stop_simulation()                      # deliberate stop: LEDs off, camera to 0, "Sim stopped"
  ng.close()                                # always call at exit

  - The first set_state() runs the start-up sequence: "NestGuard ON" on the LCD, each LED flashes
    once, camera sweeps -90 -> +90 -> 0. (Or call ng.start_simulation() yourself.)
  - Fail-safe: if set_state() isn't called for 5 seconds, the red LED blinks and the LCD says NO LINK.
  - LCD messages are cut to 16 characters.

TEST WITHOUT THE SIMULATION
  python3 nestguard_hw.py            # print what was found, then sensor readings every second
  python3 nestguard_hw.py --demo     # cycle GREEN / YELLOW / RED and pan the camera

SETUP (once)
  pip3 install smbus2
  sudo usermod -aG gpio,i2c $USER    then log out and back in (or run with sudo)
  Point the camera forward by hand before starting: that direction is 0 degrees.
"""
import argparse
import os
import threading
import time

import Jetson.GPIO as GPIO
from smbus2 import SMBus, i2c_msg

# ===================== PINS AND SETTINGS =====================
RED_PIN = 7
YELLOW_PIN = None                     # no yellow LED in this build (medium = green + red)
GREEN_PIN = 15
LED_PINS = [p for p in (RED_PIN, YELLOW_PIN, GREEN_PIN) if p]
STEP_PINS = (29, 31, 32, 33)          # IN1, IN2, IN3, IN4

# JetPack 6 boots the header pins as inputs (output switched off), so GPIO.output() does nothing.
# Pinmux register for each pin, from NVIDIA's Jetson.GPIO pin table (Orin Nano / NX).
PINMUX = {7: 0x2448030, 12: 0x2434088, 13: 0x243D030, 15: 0x2440020, 16: 0x243D020,
          29: 0x2430068, 31: 0x2430070, 32: 0x2434080, 33: 0x2434040}
TRISTATE, INPUT_EN, SFIO = 1 << 4, 1 << 6, 1 << 10


def enable_outputs(pins):
    """Make header pins real GPIO outputs: clear tristate, input-enable and SFIO bits. Needs root.
    Lasts until reboot; this runs every start, so that's fine."""
    import mmap
    import struct
    fd = os.open("/dev/mem", os.O_RDWR | os.O_SYNC)
    try:
        for pin in pins:
            addr = PINMUX[pin]
            base = addr & ~0xFFF
            m = mmap.mmap(fd, 4096, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE, offset=base)
            try:
                old = struct.unpack("<I", m[addr - base:addr - base + 4])[0]
                new = old & ~(TRISTATE | INPUT_EN | SFIO)
                if new != old:
                    m[addr - base:addr - base + 4] = struct.pack("<I", new)
                    print(f"pin {pin}: pinmux {old:#x} -> {new:#x} (output)")
            finally:
                m.close()
    finally:
        os.close(fd)

STEPS_PER_REV = 4096                  # half-steps per full turn (28BYJ-48 style geared motor)
STEP_DELAY_S = 0.002                  # 2 ms per half-step: 90 degrees takes about 2 seconds
PAN_MIN_DEG, PAN_MAX_DEG = -180.0, 180.0
LINK_TIMEOUT_S = 5.0
SPLASH_S = 2.0
I2C_BUSES = (7, 1, 0, 8)              # Orin Nano header pins 3/5 are usually bus 7; others tried too

HALF_STEP = [
    (1, 0, 0, 0), (1, 1, 0, 0), (0, 1, 0, 0), (0, 1, 1, 0),
    (0, 0, 1, 0), (0, 0, 1, 1), (0, 0, 0, 1), (1, 0, 0, 1),
]
COLORS = {"GREEN": (0, 255, 0), "YELLOW": (255, 160, 0), "RED": (255, 0, 0)}


def _s16(v):
    return v - 65536 if v > 32767 else v


def _s8(v):
    return v - 256 if v > 127 else v


def _sensirion_crc(data):
    c = 0xFF
    for byte in data:
        c ^= byte
        for _ in range(8):
            c = ((c << 1) ^ 0x31) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    return c


class NestGuard:
    def __init__(self, auto_start=True, show_readings=True):
        self.auto_start = auto_start
        self.show_readings = show_readings
        self._i2c = threading.Lock()
        self._lcd = threading.RLock()         # one whole LCD line at a time (two threads write the LCD)
        self._motor = threading.Lock()
        self._state_lock = threading.Lock()
        self._running = True

        # alert state
        self.state = "NOLINK"
        self.message = "Waiting for link"
        self._last_state_time = time.time()
        self._sim_running = False
        self._splash_until = 0.0
        self._blink_on = False

        # camera
        self._pan_steps = 0
        self._phase = 0
        self._cancel_sweep = threading.Event()
        self._sweep_thread = None

        # GPIO
        try:
            enable_outputs([*LED_PINS, *STEP_PINS])
        except Exception as e:
            print("Could not switch the header pins to outputs (run with sudo):", e)
        GPIO.setwarnings(False)
        GPIO.setmode(GPIO.BOARD)
        GPIO.setup([*LED_PINS, *STEP_PINS], GPIO.OUT, initial=GPIO.LOW)

        # I2C devices
        self.bus = None
        self.bus_num = None
        self.found = []
        self.lcd_type, self.lcd_addr, self.rgb_addr = None, None, None
        self.temp_type, self.temp_addr = None, None
        self._open_i2c()
        if self.bus is not None:
            self._detect_lcd()
            self._detect_temp()
            self._lcd_init()

        self._apply_state("NOLINK", "Waiting for link")
        self._watchdog = threading.Thread(target=self._watchdog_loop, daemon=True)
        self._watchdog.start()

    # ===================== PUBLIC API =====================
    def info(self):
        return {
            "i2c_bus": self.bus_num,
            "i2c_devices": [hex(a) for a in self.found],
            "lcd": self.lcd_type or "NONE",
            "temp_sensor": self.temp_type or "NONE",
        }

    def set_state(self, color, message=""):
        """GREEN / YELLOW / RED + an LCD message (16 characters max). Call at least once per second."""
        color = color.strip().upper()
        if color not in COLORS:
            raise ValueError("color must be GREEN, YELLOW or RED")
        if not self._sim_running and self.auto_start:
            self.start_simulation()
        with self._state_lock:
            self._last_state_time = time.time()
            changed = color != self.state or message != self.message
        if changed:
            self._apply_state(color, message)

    def start_simulation(self):
        """Start-up sequence: splash, LED light check, camera sweep (runs in the background)."""
        self._sim_running = True
        for pin in (p for p in (GREEN_PIN, YELLOW_PIN, RED_PIN) if p):
            GPIO.output(pin, GPIO.HIGH)
            time.sleep(0.15)
            GPIO.output(pin, GPIO.LOW)
            time.sleep(0.05)
        self._update_leds()
        self._splash_until = time.time() + SPLASH_S
        self._lcd_line(0, "NestGuard ON")
        self._lcd_line(1, "Sim started")
        self._cancel_sweep.clear()
        self._sweep_thread = threading.Thread(target=self._sweep, daemon=True)
        self._sweep_thread.start()

    def stop_simulation(self):
        """Deliberate stop: LEDs off, camera back to 0, 'Sim stopped', no NO LINK warning."""
        self._sim_running = False
        self._cancel_sweep.set()
        self._splash_until = 0.0
        self._apply_state("STOPPED", "Sim stopped")
        self.pan_to(0)

    def pan_to(self, degrees, wait=True):
        """Turn the camera to an angle (-180..180). With wait=True, returns once it has stopped."""
        self._cancel_sweep.set()  # a camera command from the simulation cancels the start-up sweep
        if wait:
            self._move_to(degrees)
        else:
            threading.Thread(target=self._move_to, args=(degrees,), daemon=True).start()

    def home(self):
        """The direction the camera faces now becomes 0 degrees."""
        with self._motor:
            self._pan_steps = 0

    @property
    def pan_degrees(self):
        return round(self._pan_steps * 360.0 / STEPS_PER_REV, 1)

    def read_sensors(self):
        t, h, p = self._read_temp()
        return {"temp": t, "hum": h, "pres": p, "pan": self.pan_degrees}

    def close(self):
        self._running = False
        self._cancel_sweep.set()
        time.sleep(0.2)
        self._coils_off()
        GPIO.output(LED_PINS, GPIO.LOW)
        GPIO.cleanup()
        if self.bus is not None:
            self.bus.close()

    # ===================== ALERTS =====================
    def _update_leds(self):
        s = self.state
        blink = s == "NOLINK" and self._blink_on
        if YELLOW_PIN:                        # three LEDs: one per level
            green, yellow, red = s == "GREEN", s == "YELLOW", s == "RED" or blink
            GPIO.output(YELLOW_PIN, GPIO.HIGH if yellow else GPIO.LOW)
        else:                                 # red + green only: medium lights both
            green, red = s in ("GREEN", "YELLOW"), s in ("RED", "YELLOW") or blink
        if GREEN_PIN:
            GPIO.output(GREEN_PIN, GPIO.HIGH if green else GPIO.LOW)
        GPIO.output(RED_PIN, GPIO.HIGH if red else GPIO.LOW)

    def _apply_state(self, state, message):
        with self._state_lock:
            self.state = state
            self.message = message
        self._update_leds()
        if time.time() >= self._splash_until:
            self._lcd_line(0, message)
        self._set_backlight(*COLORS.get(state, (255, 0, 0) if state == "NOLINK" else (255, 255, 255)))

    def _watchdog_loop(self):
        last_blink = 0.0
        last_readings = 0.0
        splash_shown = False
        while self._running:
            now = time.time()
            with self._state_lock:
                timed_out = (self.state not in ("NOLINK", "STOPPED")
                             and now - self._last_state_time > LINK_TIMEOUT_S)
            if timed_out:
                self._sim_running = False
                self._cancel_sweep.set()
                self._apply_state("NOLINK", "NO LINK")
            if now - last_blink >= 0.5:
                last_blink = now
                self._blink_on = not self._blink_on
                if self.state == "NOLINK":
                    self._update_leds()
            # splash finished: show the current message
            if self._splash_until and now >= self._splash_until and not splash_shown:
                self._lcd_line(0, self.message)
                splash_shown = True
            if now < self._splash_until:
                splash_shown = False
            # readings on LCD line 2 every 2 seconds
            if self.show_readings and now - last_readings >= 2.0 and now >= self._splash_until:
                last_readings = now
                t, h, _ = self._read_temp()
                line = ""
                if t is not None:
                    line += f"T{t:.1f}C"
                if h is not None:
                    line += f" H{h:.0f}%"
                line += f" P{self.pan_degrees:.0f}"
                self._lcd_line(1, line)
            time.sleep(0.05)

    # ===================== CAMERA STEPPER =====================
    def _coils_off(self):
        GPIO.output(list(STEP_PINS), GPIO.LOW)

    def _move_to(self, degrees, cancel_event=None):
        degrees = max(PAN_MIN_DEG, min(PAN_MAX_DEG, float(degrees)))
        target = int(round(degrees * STEPS_PER_REV / 360.0))
        with self._motor:
            while self._pan_steps != target:
                if cancel_event is not None and cancel_event.is_set():
                    break
                if target > self._pan_steps:
                    self._phase = (self._phase + 1) % 8
                    self._pan_steps += 1
                else:
                    self._phase = (self._phase + 7) % 8
                    self._pan_steps -= 1
                for pin, level in zip(STEP_PINS, HALF_STEP[self._phase]):
                    GPIO.output(pin, level)
                time.sleep(STEP_DELAY_S)
            self._coils_off()

    def _sweep(self):
        for angle in (-90, 90, 0):
            if self._cancel_sweep.is_set():
                return
            self._move_to(angle, cancel_event=self._cancel_sweep)

    # ===================== I2C =====================
    def _open_i2c(self):
        for num in I2C_BUSES:
            if not os.path.exists(f"/dev/i2c-{num}"):
                continue
            try:
                bus = SMBus(num)
            except OSError:
                continue
            found = [a for a in range(0x08, 0x78) if self._present(bus, a)]
            if found:
                self.bus, self.bus_num, self.found = bus, num, found
                return
            bus.close()

    @staticmethod
    def _present(bus, addr):
        try:
            bus.write_quick(addr)
            return True
        except OSError:
            try:
                bus.read_byte(addr)
                return True
            except OSError:
                return False

    def _write(self, addr, data):
        with self._i2c:
            self.bus.i2c_rdwr(i2c_msg.write(addr, list(data)))

    def _read(self, addr, n):
        msg = i2c_msg.read(addr, n)
        with self._i2c:
            self.bus.i2c_rdwr(msg)
        return list(msg)

    def _read_regs(self, addr, reg, n):
        with self._i2c:
            return self.bus.read_i2c_block_data(addr, reg, n)

    def _write_reg(self, addr, reg, val):
        with self._i2c:
            self.bus.write_byte_data(addr, reg, val)

    # ===================== LCD =====================
    def _detect_lcd(self):
        if 0x3E in self.found or 0x62 in self.found or 0x30 in self.found:   # V4 text chip often hides from scans
            self.lcd_type, self.lcd_addr = "GROVE", 0x3E
            if 0x62 in self.found:
                self.rgb_addr = 0x62
            elif 0x30 in self.found:
                self.rgb_addr = 0x30
            return
        for a in (0x27, 0x3F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26):
            if a in self.found:
                self.lcd_type, self.lcd_addr = "PCF8574", a
                return

    def _pcf_write(self, v):
        with self._i2c:
            self.bus.write_byte(self.lcd_addr, v | 0x08)  # 0x08 = backlight on

    def _pcf_write4(self, v):
        self._pcf_write(v)
        self._pcf_write(v | 0x04)   # enable high
        self._pcf_write(v & ~0x04)  # enable low

    def _lcd_send(self, val, is_data):
        try:
            if self.lcd_type == "GROVE":
                self._write_reg(self.lcd_addr, 0x40 if is_data else 0x80, val)
            elif self.lcd_type == "PCF8574":
                mode = 0x01 if is_data else 0x00
                self._pcf_write4((val & 0xF0) | mode)
                self._pcf_write4(((val << 4) & 0xF0) | mode)
        except OSError:
            pass  # a loose LCD wire must never crash the alerts
        if not is_data and val in (0x01, 0x02):
            time.sleep(0.002)

    def _lcd_init(self):
        if self.lcd_type == "GROVE":
            time.sleep(0.05)
            for _ in range(4):
                self._lcd_send(0x28, False)  # 2 lines, 5x8 font
                time.sleep(0.005)
        elif self.lcd_type == "PCF8574":
            self._pcf_write(0)
            time.sleep(0.05)
            for _ in range(3):
                self._pcf_write4(0x30)
                time.sleep(0.005)
            self._pcf_write4(0x20)          # 4-bit mode
            self._lcd_send(0x28, False)
        else:
            return
        self._lcd_send(0x0C, False)  # display on, cursor off
        self._lcd_send(0x01, False)  # clear
        self._lcd_send(0x06, False)  # left to right
        try:
            if self.rgb_addr == 0x62:
                self._write_reg(0x62, 0x00, 0x00)
                self._write_reg(0x62, 0x08, 0xFF)
                self._write_reg(0x62, 0x01, 0x20)
            elif self.rgb_addr == 0x30:
                self._write_reg(0x30, 0x00, 0x07)
                time.sleep(0.001)
                self._write_reg(0x30, 0x04, 0x15)
        except OSError:
            pass
        self._set_backlight(255, 255, 255)

    def _set_backlight(self, r, g, b):
        try:
            if self.rgb_addr == 0x62:
                self._write_reg(0x62, 0x04, r)
                self._write_reg(0x62, 0x03, g)
                self._write_reg(0x62, 0x02, b)
            elif self.rgb_addr == 0x30:
                self._write_reg(0x30, 0x06, r)
                self._write_reg(0x30, 0x07, g)
                self._write_reg(0x30, 0x08, b)
        except OSError:
            pass

    def _lcd_line(self, row, text):
        if not self.lcd_type:
            return
        with self._lcd:                       # else the watchdog's line 2 can land in the middle of line 1
            self._lcd_send(0x80 if row == 0 else 0xC0, False)
            for ch in str(text)[:16].ljust(16):
                self._lcd_send(ord(ch) if ord(ch) < 128 else ord("?"), True)

    # ===================== TEMPERATURE SENSOR =====================
    def _detect_temp(self):
        for a in (0x44, 0x45):
            if a in self.found:
                for kind in ("SHT3X", "SHT4X"):
                    self.temp_type, self.temp_addr = kind, a
                    if self._read_temp()[0] is not None:
                        return
        if 0x38 in self.found:
            try:
                status = self._read(0x38, 1)[0]
                if not status & 0x08:
                    self._write(0x38, [0xBE, 0x08, 0x00])
                    time.sleep(0.01)
                self.temp_type, self.temp_addr = "AHT20", 0x38
                return
            except OSError:
                pass
        for a in (0x76, 0x77):
            if a in self.found:
                try:
                    chip = self._read_regs(a, 0xD0, 1)[0]
                    if chip in (0x60, 0x58):
                        self._bme_init(a, chip == 0x60)
                        self.temp_type = "BME280" if chip == 0x60 else "BMP280"
                        self.temp_addr = a
                        return
                except OSError:
                    pass
        for a in range(0x18, 0x20):
            if a in self.found:
                try:
                    m = self._read_regs(a, 0x06, 2)
                    if m == [0x00, 0x54]:
                        self.temp_type, self.temp_addr = "MCP9808", a
                        return
                except OSError:
                    pass
        self.temp_type, self.temp_addr = None, None

    def _read_temp(self):
        """Returns (temp_C, humidity_pct, pressure_hPa); None for anything not available."""
        try:
            if self.temp_type == "SHT3X":
                self._write(self.temp_addr, [0x24, 0x00])
                time.sleep(0.02)
                return self._sensirion(self.temp_addr, sht4=False)
            if self.temp_type == "SHT4X":
                self._write(self.temp_addr, [0xFD])
                time.sleep(0.01)
                return self._sensirion(self.temp_addr, sht4=True)
            if self.temp_type == "AHT20":
                self._write(0x38, [0xAC, 0x33, 0x00])
                time.sleep(0.08)
                b = self._read(0x38, 7)
                if b[0] & 0x80:
                    return None, None, None
                rh = (b[1] << 12) | (b[2] << 4) | (b[3] >> 4)
                rt = ((b[3] & 0x0F) << 16) | (b[4] << 8) | b[5]
                return round(rt * 200.0 / 1048576 - 50, 1), round(rh * 100.0 / 1048576, 1), None
            if self.temp_type in ("BME280", "BMP280"):
                return self._bme_read(self.temp_addr, self.temp_type == "BME280")
            if self.temp_type == "MCP9808":
                b = self._read_regs(self.temp_addr, 0x05, 2)
                upper = b[0] & 0x1F
                t = (upper & 0x0F) * 16 + b[1] / 16.0 - (256 if upper & 0x10 else 0)
                return round(t, 1), None, None
        except OSError:
            pass
        return None, None, None

    def _sensirion(self, addr, sht4):
        b = self._read(addr, 6)
        if _sensirion_crc(b[0:2]) != b[2] or _sensirion_crc(b[3:5]) != b[5]:
            return None, None, None
        rt = (b[0] << 8) | b[1]
        rh = (b[3] << 8) | b[4]
        t = -45 + 175 * rt / 65535.0
        h = (-6 + 125 * rh / 65535.0) if sht4 else (100 * rh / 65535.0)
        return round(t, 1), round(max(0.0, min(100.0, h)), 1), None

    def _bme_init(self, a, has_hum):
        c = self._read_regs(a, 0x88, 26)
        w = lambda i: c[i] | (c[i + 1] << 8)
        self.dT = (w(0), _s16(w(2)), _s16(w(4)))
        self.dP = (w(6),) + tuple(_s16(w(i)) for i in range(8, 24, 2))
        self.dH1 = c[25]
        if has_hum:
            h = self._read_regs(a, 0xE1, 7)
            self.dH2 = _s16(h[0] | (h[1] << 8))
            self.dH3 = h[2]
            self.dH4 = (_s8(h[3]) << 4) | (h[4] & 0x0F)
            self.dH5 = (_s8(h[5]) << 4) | (h[4] >> 4)
            self.dH6 = _s8(h[6])
            self._write_reg(a, 0xF2, 0x01)  # humidity oversampling x1
        self._write_reg(a, 0xF5, 0xA0)      # 1000 ms standby
        self._write_reg(a, 0xF4, 0x27)      # temp x1, pressure x1, normal mode

    def _bme_read(self, a, has_hum):
        d = self._read_regs(a, 0xF7, 8)
        adc_p = (d[0] << 12) | (d[1] << 4) | (d[2] >> 4)
        adc_t = (d[3] << 12) | (d[4] << 4) | (d[5] >> 4)
        adc_h = (d[6] << 8) | d[7]
        T1, T2, T3 = self.dT
        P1, P2, P3, P4, P5, P6, P7, P8, P9 = self.dP
        v1 = (adc_t / 16384.0 - T1 / 1024.0) * T2
        v2 = (adc_t / 131072.0 - T1 / 8192.0) ** 2 * T3
        t_fine = v1 + v2
        temp = t_fine / 5120.0
        v1 = t_fine / 2.0 - 64000.0
        v2 = v1 * v1 * P6 / 32768.0 + v1 * P5 * 2.0
        v2 = v2 / 4.0 + P4 * 65536.0
        v1 = (P3 * v1 * v1 / 524288.0 + P2 * v1) / 524288.0
        v1 = (1.0 + v1 / 32768.0) * P1
        pres = None
        if v1 != 0:
            p = 1048576.0 - adc_p
            p = (p - v2 / 4096.0) * 6250.0 / v1
            p = p + (P9 * p * p / 2147483648.0 + p * P8 / 32768.0 + P7) / 16.0
            pres = round(p / 100.0, 1)
        hum = None
        if has_hum:
            vh = t_fine - 76800.0
            vh = (adc_h - (self.dH4 * 64.0 + self.dH5 / 16384.0 * vh)) * (
                self.dH2 / 65536.0 * (1.0 + self.dH6 / 67108864.0 * vh * (1.0 + self.dH3 / 67108864.0 * vh)))
            vh = vh * (1.0 - self.dH1 * vh / 524288.0)
            hum = round(max(0.0, min(100.0, vh)), 1)
        return round(temp, 1), hum, pres


# ===================== TEST / DEMO =====================
def main():
    ap = argparse.ArgumentParser(description="NestGuard Jetson hardware test")
    ap.add_argument("--demo", action="store_true", help="cycle GREEN / YELLOW / RED and pan the camera")
    args = ap.parse_args()

    ng = NestGuard()
    print("Found:", ng.info())
    if ng.bus is None:
        print("No I2C devices found: check SDA -> pin 3, SCL -> pin 5, VCC -> pin 1, GND -> pin 9.")
    try:
        if args.demo:
            steps = [("GREEN", "RISK 12 (low)", -90), ("YELLOW", "RISK 45 (medium)", 0),
                     ("RED", "RISK 82 (high)", 90), ("GREEN", "RISK 12 (low)", 0)]
            i = 0
            while True:
                color, msg, angle = steps[i % len(steps)]
                print(f"-> {color} '{msg}', camera to {angle}")
                ng.set_state(color, msg)
                ng.pan_to(angle, wait=False)
                for _ in range(6):  # keep the heartbeat going: once per second
                    time.sleep(1)
                    ng.set_state(color, msg)
                    print("   ", ng.read_sensors())
                i += 1
        else:
            print("Showing readings every second. The red LED blinks: nothing is calling set_state().")
            while True:
                print(ng.read_sensors())
                time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        ng.close()


if __name__ == "__main__":
    main()
