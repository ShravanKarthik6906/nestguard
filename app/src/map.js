import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export const COLORS = { green: '#2f9e5b', yellow: '#d99a1e', red: '#d64545' }

let map, zoneLayer, pin

export function createMap(el, center) {
  map = L.map(el).setView([center.lat, center.lon], 14)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
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
      radius: z.radius_m, color, fillColor: color, fillOpacity: 0.22, weight: 1,
      interactive: false,
    }).addTo(zoneLayer)
  }
}

// The pilot's chosen spot (never a bird location).
export function setPin(lat, lon) {
  if (!pin) pin = L.circleMarker([lat, lon], { radius: 8, color: '#0e1013', weight: 3, fillColor: '#e8ebef', fillOpacity: 1 }).addTo(map)
  else pin.setLatLng([lat, lon])
}
