import './style.css'
import { RPI, USE_MOCK } from './config.js'
import { getZones, check } from './api.js'
import { createMap, drawZones, setPin } from './map.js'
import { showLoading, showCheck, showCheckError } from './check.js'
import { startDemo, stopDemo, DEMO_DATE } from './demo.js'
import { announce } from './speech.js'

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
    announce(data)
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
    if (!$('demo-stop').hidden) stopWalk()
    $('date').value = p.date()
    pickSpot(p.lat, p.lon, { pan: true })
    loadZonesSoon() // date changed even if the map didn't move
  })
})

// ---- demo walk (indoors, no GPS): the app moves, the device follows via /device/demo
$('demo-start').addEventListener('click', () => {
  $('date').value = DEMO_DATE
  $('demo-start').hidden = true
  $('demo-stop').hidden = false
  map.setView([33.715, -118.025], 14)
  startDemo(
    (p, i, n) => {
      $('demo-info').textContent = `Point ${i + 1}/${n}`
      pickSpot(p.lat, p.lon)
    },
    (msg) => setStatus(msg, 'error'),
  )
})

async function stopWalk() {
  $('demo-stop').hidden = true
  $('demo-start').hidden = false
  $('demo-info').textContent = ''
  try {
    await stopDemo()
    setStatus('Demo stopped', '')
  } catch (err) {
    setStatus('Stop not sent: ' + err.message + ' (tap Stop again)', 'error')
    $('demo-stop').hidden = false
  }
}
$('demo-stop').addEventListener('click', stopWalk)

loadZones()
if (USE_MOCK) document.title = 'NestGuard (mock)'
