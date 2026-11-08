import { USE_MOCK, TIMEOUT_MS } from './config.js'
import mockZones from '../mock/zones.json'
import mockGreen from '../mock/check-green.json'
import mockYellow from '../mock/check-yellow.json'
import mockRed from '../mock/check-red.json'
import mockBolsa from '../mock/check-bolsa.json'
import mockTelemetry from '../mock/telemetry.json'
import mockPowerlines from '../mock/powerlines.json'

// Every call returns { data, source } where source is 'live', 'cached' or 'mock'.

async function getJSON(path, timeoutMs = TIMEOUT_MS) {
  const key = 'ng:' + path
  try {
    const res = await fetch(path, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    try { localStorage.setItem(key, JSON.stringify(data)) } catch {}
    return { data, source: 'live' }
  } catch (err) {
    let saved = null
    try { saved = localStorage.getItem(key) } catch {}
    if (saved) return { data: JSON.parse(saved), source: 'cached' }
    throw err
  }
}

const r4 = (v) => Number(v).toFixed(4)

export function distM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180
  const h = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2
  return 12742000 * Math.asin(Math.sqrt(h))
}

// Mock: zones only "exist" in nesting season (April-August), like the real API.
const inSeason = (date) => { const m = Number(date.slice(5, 7)); return m >= 4 && m <= 8 }

function mockGetZones(lat, lon, radiusKm, date) {
  if (!inSeason(date)) return []
  return mockZones.filter((z) => distM(lat, lon, z.lat, z.lon) <= radiusKm * 1000)
}

export async function getZones(lat, lon, radiusKm, date) {
  if (USE_MOCK) return { data: mockGetZones(lat, lon, radiusKm, date), source: 'mock' }
  return getJSON(`/zones?lat=${r4(lat)}&lon=${r4(lon)}&radius_km=${Math.round(radiusKm)}&date=${date}`)
}

// Mock /check: same "inside a zone" rule as main.py's mock score.
function mockCheck(lat, lon, date) {
  const zones = mockGetZones(lat, lon, 5, date)
  const d = (z) => distM(lat, lon, z.lat, z.lon)
  let r = mockGreen
  if (zones.some((z) => z.level === 'red' && d(z) <= z.radius_m)) r = lat < 35 ? mockBolsa : mockRed
  else if (zones.some((z) => d(z) <= z.radius_m + 300)) r = mockYellow
  return { ...r, zones }
}

export async function check(lat, lon, date) {
  if (USE_MOCK) return { data: mockCheck(lat, lon, date), source: 'mock' }
  return getJSON(`/check?lat=${r4(lat)}&lon=${r4(lon)}&date=${date}`)
}

// Tell the device where to "be". {} stops demo mode. Not cached; skipped in mock mode.
export async function setDemo(body) {
  if (USE_MOCK) return
  const res = await fetch('/device/demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
}

// Gemini's one-sentence "why". Separate, slower call so the banner never waits for it.
export async function explain(lat, lon, date) {
  if (USE_MOCK) return { data: { why: null }, source: 'mock' }
  return getJSON(`/check?lat=${r4(lat)}&lon=${r4(lon)}&date=${date}&explain=true`, 20000)
}

// Latest device readings. Never cached: an old reading must not look live.
export async function getTelemetry() {
  if (USE_MOCK) return { ...mockTelemetry, ts: new Date().toISOString().slice(0, 19) }
  const res = await fetch('/device/telemetry', { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

// Power lines near a point: [{ coords: [[lat, lon], ...] }]. Public infrastructure, so exact lines are fine.
export async function getPowerlines(lat, lon, radiusKm) {
  if (USE_MOCK) {
    const near = (line) => line.coords.some(([a, b]) => distM(lat, lon, a, b) <= (radiusKm + 1) * 1000)
    return { data: mockPowerlines.filter(near), source: 'mock' }
  }
  return getJSON(`/powerlines?lat=${r4(lat)}&lon=${r4(lon)}&radius_km=${radiusKm}`)
}
