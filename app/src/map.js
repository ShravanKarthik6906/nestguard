import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MAPBOX_TOKEN, MAPBOX_STYLE } from './config.js'

export const COLORS = { green: '#2f9e5b', yellow: '#d99a1e', red: '#d64545' }

let map, zoneLayer, powerLayer, pin

// Fallback: standard OpenStreetMap tiles, darkened with CSS (.osm-dark in style.css)
const osmLayer = () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, className: 'osm-dark', attribution: '&copy; OpenStreetMap contributors',
})

// Mapbox satellite imagery with streets; switches to OpenStreetMap if Mapbox keeps failing
function addBaseMap() {
  if (!MAPBOX_TOKEN) return osmLayer().addTo(map)
  const mb = L.tileLayer(`https://api.mapbox.com/styles/v1/${MAPBOX_STYLE}/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`, {
    maxZoom: 20, tileSize: 512, zoomOffset: -1, className: 'sat',
    attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map)
  let errors = 0, loaded = 0
  mb.on('tileload', () => { loaded++ })
  mb.on('tileerror', () => {
    if (++errors >= 4 && loaded === 0) { map.removeLayer(mb); osmLayer().addTo(map) }
  })
}

export function createMap(el, center) {
  map = L.map(el).setView([center.lat, center.lon], 14)
  addBaseMap()
  zoneLayer = L.layerGroup().addTo(map)
  powerLayer = L.layerGroup().addTo(map)
  return map
}

// Zones are already blurred by the API. We draw only the circle: no markers,
// no popups, no extra fields, so nothing more precise than the API gives ever shows.
export function drawZones(zones) {
  zoneLayer.clearLayers()
  for (const z of zones) {
    const color = COLORS[z.level] || COLORS.yellow
    L.circle([z.lat, z.lon], {
      radius: z.radius_m, color, fillColor: color, fillOpacity: 0.3, weight: 2,
      interactive: false,
    }).addTo(zoneLayer)
  }
}

// The pilot's chosen spot (never a bird location).
export function setPin(lat, lon) {
  if (!pin) pin = L.circleMarker([lat, lon], { radius: 8, color: '#0e1013', weight: 3, fillColor: '#e8ebef', fillOpacity: 1 }).addTo(map)
  else pin.setLatLng([lat, lon])
}

export function drawPowerlines(lines) {
  powerLayer.clearLayers()
  for (const l of lines) {
    if (Array.isArray(l.coords) && l.coords.length > 1) {
      L.polyline(l.coords, { color: COLORS.red, weight: 3, opacity: 1, interactive: false }).addTo(powerLayer)
    }
  }
}

export function showPowerlines(on) {
  if (on) powerLayer.addTo(map)
  else powerLayer.remove()
}
