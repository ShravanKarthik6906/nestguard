import { setDemo } from './api.js'

// Fake walk at Bolsa Chica on the day of the 2021 drone crash.
export const DEMO_DATE = '2021-05-13'
const START = { lat: 33.725, lon: -118.005 }
const END = { lat: 33.705, lon: -118.045 }
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
    try { await setDemo({ lat: p.lat, lon: p.lon, date: DEMO_DATE }) }
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
