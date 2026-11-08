import { setDemo } from './api.js'

// Live demo walk in Troy, today: from RPI campus to a spot about 40 m from a power line.
// Every point is a real check with today's weather, birds and power lines.
export const demoDate = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const START = { lat: 42.7302, lon: -73.6788 } // RPI campus
export const END = { lat: 42.7493, lon: -73.694138 } // next to a power line (pre-loaded OpenStreetMap data)
const STEPS = 10
const EVERY_MS = 2000

const PATH = Array.from({ length: STEPS }, (_, i) => {
  const t = i / (STEPS - 1)
  return {
    lat: +(START.lat + (END.lat - START.lat) * t).toFixed(5),
    lon: +(START.lon + (END.lon - START.lon) * t).toFixed(5),
  }
})

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
