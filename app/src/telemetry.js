import { getTelemetry } from './api.js'

// Polls the device's latest readings every 10 s.
// "Online" = the reading is under 30 s old, OR its ts changed in the last 30 s.
// The second rule keeps it working even if the device's clock or timezone is off.
const POLL_MS = 10000
const FRESH_MS = 30000
const $ = (id) => document.getElementById(id)

let lastTs = null
let lastChange = 0

async function poll() {
  let t = {}
  try { t = await getTelemetry() } catch {}
  const now = Date.now()
  if (t.ts && t.ts !== lastTs) {
    if (lastTs !== null) lastChange = now
    lastTs = t.ts
  }
  const age = t.ts ? now - Date.parse(t.ts) : Infinity
  const online = t.ts && (Math.abs(age) < FRESH_MS || now - lastChange < FRESH_MS)

  $('device').classList.toggle('offline', !online)
  $('device-state').textContent = online ? 'Online' : 'Offline'
  const temp = online && typeof t.temp_c === 'number'
  const light = online && typeof t.light_pct === 'number'
  $('device-temp').textContent = temp ? `${t.temp_c.toFixed(1)} °C (${Math.round(t.temp_c * 9 / 5 + 32)} °F)` : 'Not available'
  $('device-light').textContent = light ? `${Math.round(t.light_pct)} %` : 'Not available'
}

export function startTelemetry() {
  poll()
  setInterval(poll, POLL_MS)
}
