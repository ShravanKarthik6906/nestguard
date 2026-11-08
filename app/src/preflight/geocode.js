// Place search for the setup screen (Photon by komoot plus Mapbox geocoding).
// Typed coordinates ("42.73, -73.68") always work, with or without a token or a connection.
import { MAPBOX_TOKEN } from '../config.js'

export function parseCoords(text) {
  const m = String(text).trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/)
  if (!m) return null
  const lat = Number(m[1]), lon = Number(m[2])
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon, name: `${lat.toFixed(4)}, ${lon.toFixed(4)}` }
}


// Returns up to 6 places: [{ name, lat, lon }]. Two sources, merged:
//  - Mapbox (addresses, towns), with the app's public token
//  - Photon by komoot (OpenStreetMap data, free, made for search-as-you-type): much better for named
//    places such as buildings, dining halls and parks
// Both are biased towards `near` ({lat, lon}) so local results come first.

async function mapbox(q, near, signal) {
  if (!MAPBOX_TOKEN) return []
  const prox = near ? `&proximity=${near.lon.toFixed(4)},${near.lat.toFixed(4)}` : ''
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
    `?autocomplete=true&limit=5&types=poi,address,place,locality,neighborhood,postcode${prox}&access_token=${MAPBOX_TOKEN}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return ((await res.json()).features || []).map((f) => ({ name: f.place_name, lat: f.center[1], lon: f.center[0] }))
}

async function photon(q, near, signal) {
  const bias = near ? `&lat=${near.lat.toFixed(4)}&lon=${near.lon.toFixed(4)}` : ''
  const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en${bias}`, { signal })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return ((await res.json()).features || []).map((f) => {
    const p = f.properties || {}
    const parts = [p.name, p.street && p.housenumber ? `${p.housenumber} ${p.street}` : p.street, p.city || p.town || p.village, p.state, p.country]
    const name = [...new Set(parts.filter(Boolean))].join(', ')
    return { name, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }
  }).filter((x) => x.name)
}

export async function searchPlaces(query, signal, near) {
  const coords = parseCoords(query)
  if (coords) return [coords]
  const q = query.trim()
  if (q.length < 3) return []
  // each source gets its own time limit, so one slow service never holds up the other
  const lim = () => (AbortSignal.any && signal) ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : signal
  const [a, b] = await Promise.allSettled([photon(q, near, lim()), mapbox(q, near, lim())])
  if (a.status === 'rejected' && b.status === 'rejected') throw a.reason
  // interleave, named places (Photon) first, and drop near-duplicates
  const lists = [a.value || [], b.value || []], out = []
  for (let i = 0; i < 6 && out.length < 6; i++) {
    for (const l of lists) {
      const x = l[i]
      if (x && !out.some((y) => Math.abs(y.lat - x.lat) < 0.002 && Math.abs(y.lon - x.lon) < 0.002)) out.push(x)
    }
  }
  return out.slice(0, 6)
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
