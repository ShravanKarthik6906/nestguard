// Place search for the setup screen. Uses Mapbox geocoding with the app's public Mapbox token.
// Typed coordinates ("42.73, -73.68") always work, with or without a token or a connection.
import { MAPBOX_TOKEN } from '../config.js'

export function parseCoords(text) {
  const m = String(text).trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/)
  if (!m) return null
  const lat = Number(m[1]), lon = Number(m[2])
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon, name: `${lat.toFixed(4)}, ${lon.toFixed(4)}` }
}

export const canSearch = () => Boolean(MAPBOX_TOKEN)

// Returns up to 5 places: [{ name, lat, lon }]
export async function searchPlaces(query, signal) {
  const coords = parseCoords(query)
  if (coords) return [coords]
  if (!MAPBOX_TOKEN || query.trim().length < 3) return []
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query.trim())}.json` +
    `?autocomplete=true&limit=5&types=place,locality,neighborhood,address,poi,postcode&access_token=${MAPBOX_TOKEN}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const data = await res.json()
  return (data.features || []).map((f) => ({ name: f.place_name, lat: f.center[1], lon: f.center[0] }))
}

// Name for a point picked on the map or from GPS (best effort; coordinates if it fails).
export async function placeName(lat, lon) {
  const fallback = `${lat.toFixed(4)}, ${lon.toFixed(4)}`
  if (!MAPBOX_TOKEN) return fallback
  try {
    const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?limit=1&types=place,locality,neighborhood,address,poi&access_token=${MAPBOX_TOKEN}`,
      { signal: AbortSignal.timeout(4000) })
    const f = (await res.json()).features?.[0]
    return f ? f.place_name : fallback
  } catch { return fallback }
}
