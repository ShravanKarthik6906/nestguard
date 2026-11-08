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
const osmLayer = () => retryTiles(L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, className: 'osm-dark', keepBuffer: 4, attribution: '&copy; OpenStreetMap contributors',
}))

// Slow or busy networks drop some tiles: retry each failed one up to 3 times (after 0.8, 1.6, 2.4 s)
// instead of leaving a black square. Leaflet's load handler stays attached, so a retry that succeeds
// counts as a normal load.
function retryTiles(layer) {
  layer.on('tileerror', (e) => {
    const img = e.tile, n = Number(img.dataset.retry || 0)
    if (n >= 3) return
    img.dataset.retry = String(n + 1)
    e.retrying = true
    setTimeout(() => {
      const base = img.src.replace(/[?&]retry=\d+$/, '')
      img.src = `${base}${base.includes('?') ? '&' : '?'}retry=${n + 1}`
    }, 800 * (n + 1))
  })
  return layer
}

// Mapbox satellite imagery with streets; switches to OpenStreetMap if Mapbox keeps failing
function addBaseMap() {
  if (!MAPBOX_TOKEN) return osmLayer().addTo(map)
  const mb = L.tileLayer(`https://api.mapbox.com/styles/v1/${MAPBOX_STYLE}/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`, {
    maxZoom: 20, tileSize: 512, zoomOffset: -1, className: 'sat', keepBuffer: 4,
    attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map)
  let errors = 0, loaded = 0
  mb.on('tileload', () => { loaded++ })
  retryTiles(mb)
  mb.on('tileerror', (e) => {
    if (e.retrying) return
    if (++errors >= 4 && loaded === 0) { map.removeLayer(mb); osmLayer().addTo(map) }   // Mapbox not working at all
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
let pinShown = true
export function setPin(lat, lon) {
  if (!pin) pin = L.circleMarker([lat, lon], { radius: 8, color: '#0e1013', weight: 3, fillColor: '#e8ebef', fillOpacity: 1 }).addTo(map)
  else pin.setLatLng([lat, lon])
  showPin(pinShown)
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
// The pin is hidden during the guided tour (the tour's own stop markers show the spot and its colour).
export function showPin(on) {
  pinShown = on
  if (pin) pin.setStyle({ opacity: on ? 1 : 0, fillOpacity: on ? 1 : 0 })
}
export function setPinRisk(cls) {
  if (!pin) return
  const fill = COLORS[cls] || '#e8ebef'
  pin.setStyle({ fillColor: fill, color: '#0e1013', radius: 9 })
}

// Guided tour stops: a dot plus a label ("2 Downtown 51"). Visited stops show their score in its band
// colour; the current stop is highlighted. No connecting line: the stops are places, not a path.
export function drawRoute(points, upTo = -1, scores = []) {
  routeLayer.clearLayers()
  if (!points || points.length < 2) return
  points.forEach((p, i) => {
    const sc = scores[i]
    const cls = sc == null ? 'todo' : band(sc).cls
    const label = `<b>${i + 1}</b> ${p.short || p.name || ''}${sc == null ? '' : ` <span class="stop-sc">${Math.round(sc)}</span>`}`
    L.marker([p.lat, p.lon], {
      interactive: false, keyboard: false, zIndexOffset: i === upTo ? 400 : 0,
      icon: L.divIcon({ className: 'stop-icon', iconSize: [0, 0], iconAnchor: [0, 0],
        html: `<span class="tour-stop ${cls} ${i === upTo ? 'now' : ''}"><i></i><span class="tour-l">${label}</span></span>` }),
    }).addTo(routeLayer)
  })
}
export const clearRoute = () => routeLayer && routeLayer.clearLayers()
export const getMap = () => map

// Lower-risk spot suggested by the API: a green ring the pilot can tap.
let saferMarker
const DIR_SHORT = { north: 'N', northeast: 'NE', east: 'E', southeast: 'SE', south: 'S', southwest: 'SW', west: 'W', northwest: 'NW' }
// The lower-risk spot: a labelled off-white flag ("LOWER RISK 47 · 1 km NE"). Off-white is the app's action colour,
// never a risk colour, so it can't be mistaken for your spot or a bird zone. A dotted guide links the two.
export function setSaferSpot(spot, onClick) {
  if (saferMarker) { saferMarker.remove(); saferMarker = null }
  if (!spot) return
  const dist = spot.distance_km != null ? ` · ${spot.distance_km} km ${DIR_SHORT[spot.direction] || ''}` : ''
  const flag = L.marker([spot.lat, spot.lon], {
    keyboard: false, zIndexOffset: 500, title: 'Lower-risk spot: tap to check it',
    icon: L.divIcon({ className: 'safer-icon', iconSize: [0, 0], iconAnchor: [0, 0],
      html: `<span class="safer-flag"><span class="safer-flag-l">Lower risk <b>${spot.score}</b>${dist}</span><i></i></span>` }),
  }).on('click', () => onClick && onClick())
  const layers = [flag]
  if (pin) layers.unshift(L.polyline([pin.getLatLng(), [spot.lat, spot.lon]], { color: '#e8ebef', weight: 2.5, opacity: 0.85, dashArray: '2 7', interactive: false }))
  saferMarker = L.layerGroup(layers).addTo(map)
}

// Frame your spot and the lower-risk spot together (falls back to centring on your spot).
export function frameSpot(lat, lon, minZoom = 14) {
  const flag = saferMarker && saferMarker.getLayers().find((l) => l instanceof L.Marker)
  if (flag) map.fitBounds(L.latLngBounds([[lat, lon], flag.getLatLng()]), { padding: [70, 70], maxZoom: 16 })
  else map.setView([lat, lon], Math.max(map.getZoom(), minZoom))
}
