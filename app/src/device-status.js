import { getTelemetry } from './api.js'

// Is the device (Jetson) checking in? Same rule as the pre-flight tool (telemetry.js):
// online = its latest check-in is under 30 s old, OR the check-in time changed in the last 30 s
// (the second rule keeps it working if the device clock or timezone is off).
const POLL_MS = 10000
const FRESH_MS = 30000

export function watchDevice(onChange) {
  let lastTs = null
  let lastChange = 0
  let last = null
  async function poll() {
    let t = {}
    try { t = await getTelemetry() } catch {}
    const now = Date.now()
    if (t.ts && t.ts !== lastTs) {
      if (lastTs !== null) lastChange = now
      lastTs = t.ts
    }
    const age = t.ts ? now - Date.parse(t.ts) : Infinity
    const online = Boolean(t.ts && (Math.abs(age) < FRESH_MS || now - lastChange < FRESH_MS))
    if (online !== last) { last = online; onChange(online) }
  }
  poll()
  setInterval(poll, POLL_MS)
}
