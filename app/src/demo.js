import { setDemo } from './api.js'

// Guided tour of 5 real places in Troy, checked live with today's data. Each stop shows one thing
// that makes flying risky, and the tour ends at a better place to fly. The descriptions only state
// facts from the map data (building counts and power line distances from OpenStreetMap); the score
// and the main hazard come from the live check.
export const demoDate = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const STOPS = [
  { lat: 42.7302, lon: -73.6788, name: 'RPI campus', short: 'RPI',
    point: 'Where we start: a college campus with some buildings around and no power lines close by.' },
  { lat: 42.7317, lon: -73.6889, name: 'Downtown Troy', short: 'Downtown',
    point: 'About 300 buildings within 300 m. If a drone falls here, it falls near people.' },
  { lat: 42.7310, lon: -73.6915, name: 'Hudson riverfront', short: 'Riverfront',
    point: 'Right on the Hudson River, a route that migrating birds follow. Also a dense part of town.' },
  { lat: 42.7493, lon: -73.6941, name: 'Next to a power line', short: 'Power line',
    point: 'A mapped power line about 40 m away. Wires are almost invisible on a drone camera.' },
  { lat: 42.7466, lon: -73.6677, name: 'Frear Park', short: 'Frear Park',
    point: 'An open park: almost no buildings and no power lines within 1.5 km. A better place to fly.' },
]
export const START = STOPS[0]
export const END = STOPS[3]
const EVERY_MS = 6000            // time to read each stop and hear the score

const PATH = STOPS

export const PATH_POINTS = () => PATH

let timer = null
let index = 0
let cb = { onPoint: () => {}, onDeviceError: () => {}, onEnd: () => {} }
export const isRunning = () => timer !== null
export const currentIndex = () => index

// Show one point: move the marker, run the check (onPoint) and tell the device (POST /device/demo).
async function show(i) {
  index = Math.max(0, Math.min(PATH.length - 1, i))
  const p = PATH[index]
  cb.onPoint(p, index, PATH.length)
  try { await setDemo({ lat: p.lat, lon: p.lon, date: demoDate() }) }
  catch (err) { cb.onDeviceError('Device not updated: ' + err.message) }
}

// onPoint(point, index, total) moves the marker and runs /check (done by the page).
// onDeviceError(msg) reports a failed POST without stopping the walk. onEnd() at the last point.
export function startDemo(onPoint, onDeviceError, onEnd) {
  cb = { onPoint, onDeviceError: onDeviceError || (() => {}), onEnd: onEnd || (() => {}) }
  stopTimer()
  show(0)
  resumeDemo()
}

// Step automatically every EVERY_MS; stays on the last point (device keeps its state) until Stop.
export function resumeDemo() {
  stopTimer()
  if (index >= PATH.length - 1) return
  timer = setInterval(async () => {
    await show(index + 1)
    if (index >= PATH.length - 1) { stopTimer(); cb.onEnd() }
  }, EVERY_MS)
}
export const pauseDemo = () => stopTimer()
export async function stepDemo(delta) {
  stopTimer()
  await show(index + delta)
  if (index >= PATH.length - 1) cb.onEnd()
}

function stopTimer() {
  clearInterval(timer)
  timer = null
}

export async function stopDemo() {
  stopTimer()
  await setDemo({})
}
