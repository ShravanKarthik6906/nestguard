// The one switch between mock data and the real API.
// Also flip it from the URL: ?mock=1 forces mock, ?mock=0 forces live.
const DEFAULT_MOCK = false

const param = new URLSearchParams(location.search).get('mock')
export const USE_MOCK = param === null ? DEFAULT_MOCK : param === '1'

export const TIMEOUT_MS = 4000 // slower than this -> fall back to the cached copy
export const RPI = { lat: 42.7302, lon: -73.6788 }

// Mapbox public token, read from app/.env (VITE_MAPBOX_TOKEN=pk....), which git ignores.
// No token, or Mapbox failing -> the map falls back to plain OpenStreetMap tiles.
export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || ''
export const MAPBOX_STYLE = 'mapbox/satellite-streets-v12'
