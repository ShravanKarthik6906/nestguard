import './style.css'
import { RPI, USE_MOCK } from './config.js'
import { getZones } from './api.js'
import { createMap, drawZones } from './map.js'

const $ = (id) => document.getElementById(id)

// Local date (not UTC, which is "tomorrow" in Troy after 7 PM).
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
$('date').value = new URLSearchParams(location.search).get('date') || today()

const map = createMap($('map'), RPI)

function setStatus(text, kind = '') {
  $('status').textContent = text
  $('status').className = 'status ' + kind
}

let timer
async function loadZones() {
  const c = map.getCenter()
  const radiusKm = Math.min(50, Math.max(5, c.distanceTo(map.getBounds().getNorthEast()) / 1000))
  try {
    const { data, source } = await getZones(c.lat, c.lng, radiusKm, $('date').value)
    drawZones(data)
    setStatus(`${data.length} zones · ${source}`, source)
  } catch (err) {
    setStatus('API unreachable: ' + err.message, 'error')
  }
}
const loadZonesSoon = () => { clearTimeout(timer); timer = setTimeout(loadZones, 300) }

map.on('moveend', loadZonesSoon)
$('date').addEventListener('change', loadZones)
loadZones()

if (USE_MOCK) document.title = 'NestGuard (mock)'
