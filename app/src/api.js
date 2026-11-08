import { USE_MOCK, TIMEOUT_MS } from './config.js'
import { riskOf } from './risk.js'
import mockZones from '../mock/zones.json'
import mockGreen from '../mock/check-green.json'
import mockYellow from '../mock/check-yellow.json'
import mockRed from '../mock/check-red.json'
import mockBolsa from '../mock/check-bolsa.json'
import mockTelemetry from '../mock/telemetry.json'
import mockPowerlines from '../mock/powerlines.json'
import mockPower from '../mock/check-power.json'
import mockMigration from '../mock/check-migration.json'

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

// Distance (m) from a point to the nearest mock power line segment (flat approximation, fine at this scale)
function powerDistM(lat, lon) {
  const k = Math.cos((lat * Math.PI) / 180), toXY = ([a, b]) => [(b - lon) * 111320 * k, (a - lat) * 110540]
  let best = Infinity
  for (const line of mockPowerlines) {
    const pts = line.coords.map(toXY)
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)))
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy))
    }
  }
  return best
}
const migrationSeason = (date) => [3, 4, 5, 8, 9, 10, 11].includes(Number(date.slice(5, 7)))

// Mock /check: power line within 100 m -> red; then the zone rule from main.py's mock score;
// around RPI in migration season -> yellow.
function mockCheck(lat, lon, date) {
  const zones = mockGetZones(lat, lon, 5, date)
  const d = (z) => distM(lat, lon, z.lat, z.lon)
  let r = mockGreen
  if (powerDistM(lat, lon) <= 100) r = mockPower
  else if (zones.some((z) => riskOf(z) >= 60 && d(z) <= z.radius_m)) r = lat < 35 ? mockBolsa : mockRed
  else if (zones.some((z) => d(z) <= z.radius_m + 300)) r = mockYellow
  else if (distM(lat, lon, 42.7302, -73.6788) <= 1500 && migrationSeason(date)) r = mockMigration
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
  // loads in the background, and a new area can take a while on the server (OpenStreetMap lookup)
  return getJSON(`/powerlines?lat=${r4(lat)}&lon=${r4(lon)}&radius_km=${radiusKm}`, 15000)
}

// Checks per hour with average and highest risk over the last 24 h (Tiger Data). Never cached.
export async function getStats() {
  if (USE_MOCK) return [{ hour: 'mock', checks: 9, avg_risk: 28, max_risk: 61 }, { hour: 'mock', checks: 3, avg_risk: 52, max_risk: 95 }]
  const res = await fetch('/stats/checks?hours=24', { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const rows = await res.json()
  return Array.isArray(rows) ? rows : []
}
