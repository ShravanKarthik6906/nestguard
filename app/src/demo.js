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

let timer = null
export const isRunning = () => timer !== null

// onPoint(point, index, total) moves the marker and runs /check (done in main.js).
// onDeviceError(msg) reports a failed POST without stopping the walk.
export function startDemo(onPoint, onDeviceError) {
  stopTimer()
  let i = 0
  const step = async () => {
    const p = PATH[i]
    onPoint(p, i, PATH.length)
    try { await setDemo({ lat: p.lat, lon: p.lon, date: demoDate() }) }
    catch (err) { onDeviceError('Device not updated: ' + err.message) }
    i++
    if (i >= PATH.length) stopTimer() // stay on the last (red) point until Stop
  }
  step()
  timer = setInterval(step, EVERY_MS)
}

function stopTimer() {
  clearInterval(timer)
  timer = null
}

export async function stopDemo() {
  stopTimer()
  await setDemo({})
}
