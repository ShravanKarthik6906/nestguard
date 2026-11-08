import '@fontsource/b612/400.css'
import '@fontsource/b612/700.css'
import '@fontsource/b612-mono/400.css'
import '@fontsource/b612-mono/700.css'
import './landing.css'
import { check, getStats } from '../api.js'
import { sortHazards, hazardRow } from '../hazards.js'

// The 3D scene is optional: if WebGL is missing or fails, show the text straight away.
import('./drone.js').catch((err) => {
  console.warn('3D intro unavailable:', err)
  document.body.classList.add('ready')
})

// ---- live check for RPI today (the real API; the mock switch still applies)
const $ = (id) => document.getElementById(id)
const LABELS = { green: 'Go', yellow: 'Wait', red: "Don't fly" }
const d = new Date()
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

check(42.7302, -73.6788, today).then(({ data }) => {
  const level = LABELS[data.level] ? data.level : 'yellow'
  $('live-verdict').className = 'verdict ' + level
  $('live-verdict').textContent = LABELS[level]
  $('live-message').textContent = (data.message || '').replace(/^(don't fly|wait|go)\s*[:.,-]\s*/i, '').replace(/^./, (c) => c.toUpperCase())
  $('live-hazards').replaceChildren(...sortHazards(data.hazards).slice(0, 4).map(hazardRow))
}).catch(() => {
  $('live-verdict').className = 'verdict none'
  $('live-verdict').textContent = 'The live check is unavailable right now'
})

// ---- how many checks people ran in the last 24 hours (Tiger Data)
getStats().then((rows) => {
  const total = rows.reduce((n, r) => n + (r.checks || 0), 0)
  const red = rows.filter((r) => r.level === 'red').reduce((n, r) => n + (r.checks || 0), 0)
  if (total) $('live-stats').textContent = `${total} pre-flight checks in the last 24 hours, ${red} of them said Don't fly. Counted with Tiger Data.`
}).catch(() => {})
