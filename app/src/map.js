import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export const COLORS = { green: '#2e9d4f', yellow: '#e6a700', red: '#d93025' }

let map, zoneLayer

export function createMap(el, center) {
  map = L.map(el).setView([center.lat, center.lon], 14)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map)
  zoneLayer = L.layerGroup().addTo(map)
  return map
}

// Zones are already blurred by the API. We draw only the circle: no markers,
// no popups, no extra fields, so nothing more precise than the API gives ever shows.
export function drawZones(zones) {
  zoneLayer.clearLayers()
  for (const z of zones) {
    const color = COLORS[z.level] || COLORS.yellow
    L.circle([z.lat, z.lon], {
      radius: z.radius_m, color, fillColor: color, fillOpacity: 0.25, weight: 1,
      interactive: false,
    }).addTo(zoneLayer)
  }
}
