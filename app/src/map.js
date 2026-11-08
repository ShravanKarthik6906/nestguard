import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MAPBOX_TOKEN, MAPBOX_STYLE } from './config.js'
import { band, riskOf } from './risk.js'

export const COLORS = { green: '#2f9e5b', yellow: '#d99a1e', red: '#d64545' }

let map, zoneLayer, powerLayer, routeLayer, pin
const handlers = { zone: null, line: null }
// Called when someone taps a bird zone or a power line (the redesigned tool shows an explanation panel).
export function onFeatureClick(kind, fn) { handlers[kind] = fn }

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
  // Re-measure whenever the map's box changes size (fonts loading, header wrapping, phone rotation),
  // otherwise Leaflet only draws tiles for the size it saw first and leaves the rest blank.
  new ResizeObserver(() => map.invalidateSize()).observe(el)
  zoneLayer = L.layerGroup().addTo(map)
  powerLayer = L.layerGroup().addTo(map)
  routeLayer = L.layerGroup().addTo(map)
  return map
}

// Zones are already blurred by the API. We draw only the circle: no markers,
// no popups, no extra fields, so nothing more precise than the API gives ever shows.
export function drawZones(zones) {
  zoneLayer.clearLayers()
  for (const z of zones) {
    const cls = band(riskOf(z)).cls
    const color = COLORS[cls] || COLORS.yellow
    const low = cls === 'green' // low bird risk: faint dashed outline, so it never reads as "safe to fly"
    L.circle([z.lat, z.lon], {
      radius: z.radius_m, color, fillColor: color,
      fillOpacity: low ? 0 : 0.3, weight: low ? 1 : 2, opacity: low ? 0.55 : 1, dashArray: low ? '4 6' : null,
      interactive: Boolean(handlers.zone), bubblingMouseEvents: false,
    }).on('click', () => handlers.zone && handlers.zone(z)).addTo(zoneLayer)
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
      // drawn like a map's power line (thin wire plus pylon dots) so it never looks like a red no-fly zone
      L.polyline(l.coords, { color: '#0e1013', weight: 4, opacity: 0.6, interactive: false }).addTo(powerLayer)
      L.polyline(l.coords, { color: '#f2f4f6', weight: 1.6, opacity: 0.95, interactive: false }).addTo(powerLayer)
      L.polyline(l.coords, { color: '#f2f4f6', weight: 6, opacity: 0.95, dashArray: '0 22', lineCap: 'round', interactive: false }).addTo(powerLayer)
      if (handlers.line) {
        L.polyline(l.coords, { color: '#fff', weight: 16, opacity: 0, bubblingMouseEvents: false })
          .on('click', () => handlers.line(l)).addTo(powerLayer)
      }
    }
  }
}

export function showPowerlines(on) {
  if (on) powerLayer.addTo(map)
  else powerLayer.remove()
}

// Colour the pin with the overall risk at that spot (the zones only show bird risk).
export function setPinRisk(cls) {
  if (!pin) return
  const fill = COLORS[cls] || '#e8ebef'
  pin.setStyle({ fillColor: fill, color: '#0e1013', radius: 9 })
}

// Demo walk route: the whole path faintly, the part already walked brighter.
export function drawRoute(points, upTo = -1) {
  routeLayer.clearLayers()
  if (!points || points.length < 2) return
  const ll = points.map((p) => [p.lat, p.lon])
  L.polyline(ll, { color: '#e8ebef', weight: 2, opacity: 0.35, dashArray: '4 6', interactive: false }).addTo(routeLayer)
  if (upTo > 0) L.polyline(ll.slice(0, upTo + 1), { color: '#2bb3a0', weight: 3, opacity: 0.9, interactive: false }).addTo(routeLayer)
  points.forEach((p, i) => L.circleMarker([p.lat, p.lon], { radius: 3, color: i <= upTo ? '#2bb3a0' : '#8a929d', weight: 1, fillOpacity: 1, interactive: false }).addTo(routeLayer))
}
export const clearRoute = () => routeLayer && routeLayer.clearLayers()
export const getMap = () => map
