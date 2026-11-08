import '@fontsource/b612/400.css'
import '@fontsource/b612/700.css'
import '@fontsource/b612-mono/400.css'
import '@fontsource/b612-mono/700.css'
import './style.css'
import { RPI, USE_MOCK } from './config.js'
import { getZones, check, explain, getPowerlines } from './api.js'
import { createMap, drawZones, setPin, drawPowerlines, showPowerlines } from './map.js'
import { showLoading, showCheck, showCheckError, showWhy } from './check.js'
import { startDemo, stopDemo, DEMO_DATE } from './demo.js'
import { announce } from './speech.js'
import { startTelemetry } from './telemetry.js'

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
    setStatus(`${{ live: 'Live data', cached: 'Cached data', mock: 'Offline mock data' }[source]}, ${data.length} zones`, source)
  } catch (err) {
    setStatus('API unreachable: ' + err.message, 'error')
  }
}
const loadZonesSoon = () => { clearTimeout(timer); timer = setTimeout(loadZones, 300) }
map.on('moveend', loadZonesSoon)

// ---- power lines (refetch only when the map moved a lot; hidden when zoomed far out)
const POWER_MIN_ZOOM = 12
let powerAt = null, powerTimer
async function loadPowerlines() {
  const c = map.getCenter(), z = map.getZoom()
  if (z < POWER_MIN_ZOOM) { drawPowerlines([]); powerAt = null; $('power-note').textContent = 'Zoom in to see power lines'; return }
  const radiusKm = Math.min(3, Math.max(1, Math.round(c.distanceTo(map.getBounds().getNorthEast()) / 1000)))
  if (powerAt && powerAt.r === radiusKm && c.distanceTo(powerAt.c) < radiusKm * 1000 * 0.4) return
  powerAt = { c, r: radiusKm }
  try {
    const { data } = await getPowerlines(c.lat, c.lng, radiusKm)
    drawPowerlines(Array.isArray(data) ? data : [])
    $('power-note').textContent = ''
  } catch {
    powerAt = null
    $('power-note').textContent = 'Power lines unavailable'
  }
}
map.on('moveend', () => { clearTimeout(powerTimer); powerTimer = setTimeout(loadPowerlines, 500) })

let powerOn = true
try { powerOn = localStorage.getItem('ng:power') !== 'off' } catch {}
$('power-toggle').checked = powerOn
showPowerlines(powerOn)
$('power-toggle').addEventListener('change', (e) => {
  showPowerlines(e.target.checked)
  try { localStorage.setItem('ng:power', e.target.checked ? 'on' : 'off') } catch {}
})

// ---- check
let spot = null
const narrow = matchMedia('(max-width: 959px)') // phones: bring the answer into view
let checkId = 0 // only the newest answer is shown, even if an older one arrives late

async function runCheck({ speak = true, why = speak } = {}) {
  if (!spot) return
  const id = ++checkId
  showLoading()
  try {
    const { data, source } = await check(spot.lat, spot.lon, $('date').value)
    if (id !== checkId) return
    showCheck(data)
    announce(data, { force: speak })
    if (source !== 'live') setStatus(source === 'mock' ? 'Offline mock data' : 'Cached result (network is slow)', source)
    if (speak && narrow.matches) $('banner').scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (why) loadWhy(id) // someone tapped: ask Gemini why (never during the walk)
    else showWhy(null)
  } catch (err) {
    if (id === checkId) showCheckError('API unreachable: ' + err.message)
  }
}

async function loadWhy(id) {
  showWhy(undefined)
  try {
    const { data } = await explain(spot.lat, spot.lon, $('date').value)
    if (id === checkId) showWhy(data.why || null)
  } catch {
    if (id === checkId) showWhy(null)
  }
}

export function pickSpot(lat, lon, { pan = false, speak = true, why = speak } = {}) {
  spot = { lat, lon }
  setPin(lat, lon)
  $('where').textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`
  if (pan) map.setView([lat, lon], 14)
  runCheck({ speak, why })
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
  'power':     { lat: 42.7493, lon: -73.694138, date: today },
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
      $('demo-info').textContent = `Point ${i + 1} of ${n}`
      pickSpot(p.lat, p.lon, { speak: i === 0, why: false }) // walk: first point, then only level changes
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

// Deep link from the landing page or the demo script: /preflight.html?scenario=bolsa (rpi-today, rpi-may, bolsa, power)
const scenario = new URLSearchParams(location.search).get('scenario')
if (scenario && PRESETS[scenario]) document.querySelector(`[data-preset="${scenario}"]`).click()

loadZones()
loadPowerlines()
startTelemetry()
if (USE_MOCK) document.title += ' (mock)'
