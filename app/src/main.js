import './style.css'
import { RPI, USE_MOCK } from './config.js'
import { getZones, check } from './api.js'
import { createMap, drawZones, setPin } from './map.js'
import { showLoading, showCheck, showCheckError } from './check.js'

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

// ---- map zones
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

// ---- check
let spot = null
let checkId = 0 // only the newest answer is shown, even if an older one arrives late

async function runCheck() {
  if (!spot) return
  const id = ++checkId
  showLoading()
  try {
    const { data, source } = await check(spot.lat, spot.lon, $('date').value)
    if (id !== checkId) return
    showCheck(data)
    if (source !== 'live') setStatus('check · ' + source, source)
  } catch (err) {
    if (id === checkId) showCheckError('API unreachable: ' + err.message)
  }
}

export function pickSpot(lat, lon, { pan = false } = {}) {
  spot = { lat, lon }
  setPin(lat, lon)
  $('where').textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`
  if (pan) map.setView([lat, lon], 14)
  runCheck()
}

map.on('click', (e) => pickSpot(e.latlng.lat, e.latlng.lng))

$('date').addEventListener('change', () => { loadZones(); runCheck() })

$('locate').addEventListener('click', () => {
  if (!navigator.geolocation || !window.isSecureContext) {
    return showCheckError('Location needs https (or localhost). Tap the map instead.')
  }
  navigator.geolocation.getCurrentPosition(
    (p) => pickSpot(p.coords.latitude, p.coords.longitude, { pan: true }),
    (err) => showCheckError('Location failed: ' + err.message),
    { enableHighAccuracy: true, timeout: 10000 },
  )
})

// ---- presets for Dhruv's demo script
const PRESETS = {
  'rpi-today': { lat: 42.7302, lon: -73.6788, date: today },
  'rpi-may':   { lat: 42.7302, lon: -73.6788, date: () => '2027-05-15' },
  'bolsa':     { lat: 33.70, lon: -118.04, date: () => '2021-05-13' },
}
document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = PRESETS[btn.dataset.preset]
    $('date').value = p.date()
    pickSpot(p.lat, p.lon, { pan: true })
    loadZonesSoon() // date changed even if the map didn't move
  })
})

loadZones()
if (USE_MOCK) document.title = 'NestGuard (mock)'
