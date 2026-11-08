// The same risk score the KnowFlyZone app shows, from the main API (/check).
// The simulator's own engine is only a fallback if /check can't be reached.

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Planned flight height from the app's link (/fly/?lat=..&lon=..&height=200), so the score matches the app.
const PLANNED_HEIGHT_FT = (() => {
  const h = Number(new URLSearchParams(window.location.search).get('height'))
  return Number.isFinite(h) && h >= 10 && h <= 400 ? Math.round(h) : null
})()

export async function getKnowFlyZoneCheck(lat, lon, signal) {
  const height = PLANNED_HEIGHT_FT ? `&height_ft=${PLANNED_HEIGHT_FT}` : ''
  const url = `/check?lat=${encodeURIComponent(lat.toFixed(5))}&lon=${encodeURIComponent(lon.toFixed(5))}&date=${today()}${height}`
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`KnowFlyZone check failed (HTTP ${response.status})`)
  const data = await response.json()
  if (!Number.isFinite(Number(data.score))) throw new Error('KnowFlyZone check returned no score')
  return {
    score: Math.round(Number(data.score)),
    driver: String(data.message || '').replace(/^Risk \d+\/100:\s*/, ''),
    hazards: Array.isArray(data.hazards) ? data.hazards : []
  }
}

// Same bands as the app: low 0-29, medium 30-59, high 60-100.
export function bandOf(score) {
  if (score == null || !Number.isFinite(score)) return 'UNKNOWN'
  return score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW'
}
