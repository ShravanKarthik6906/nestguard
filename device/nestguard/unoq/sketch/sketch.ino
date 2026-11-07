// NestGuard UNO Q - microcontroller side.
// Reads the Grove temperature sensor (A0) and light sensor (A1) once a second
// and hands the raw numbers to the Linux side (python/main.py) over the Bridge.
// Power both Grove sensors from the 3.3V pin: A0-A5 do NOT tolerate 5V.

#include "Arduino_RouterBridge.h"

const int TEMP_PIN = A0;
const int LIGHT_PIN = A1;

void setup() {
  analogReadResolution(10);   // 0-1023. If this line won't compile, delete it (10-bit is the default).
  Bridge.begin();
}

void loop() {
  static unsigned long last = 0;
  if (millis() - last >= 1000) {
    last = millis();
    int t = analogRead(TEMP_PIN);
    int l = analogRead(LIGHT_PIN);
    Bridge.notify("readings", t, l);   // fire-and-forget, never blocks loop()
  }
}
