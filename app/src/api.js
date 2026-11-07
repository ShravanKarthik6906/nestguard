import { USE_MOCK, TIMEOUT_MS } from './config.js'
import mockZones from '../mock/zones.json'

// Every call returns { data, source } where source is 'live', 'cached' or 'mock'.

async function getJSON(path) {
  const key = 'ng:' + path
  try {
    const res = await fetch(path, { signal: AbortSignal.timeout(TIMEOUT_MS) })
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
