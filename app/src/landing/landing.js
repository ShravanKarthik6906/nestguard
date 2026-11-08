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
  $('live-verdict').className = 'word ' + level
  $('live-verdict').textContent = LABELS[level]
  $('live-message').textContent = (data.message || '').replace(/^(don't fly|wait|go)\s*[:.,-]\s*/i, '').replace(/^./, (c) => c.toUpperCase())
  $('live-hazards').replaceChildren(...sortHazards(data.hazards).slice(0, 4).map(hazardRow))
}).catch(() => {
  $('live-verdict').className = 'word none'
  $('live-verdict').textContent = 'unavailable right now'
})

// ---- how many checks people ran in the last 24 hours (Tiger Data)
getStats().then((rows) => {
  const total = rows.reduce((n, r) => n + (r.checks || 0), 0)
  const red = rows.filter((r) => r.level === 'red').reduce((n, r) => n + (r.checks || 0), 0)
  if (total) $('live-stats').textContent = `${total} pre-flight checks were run in the last 24 hours, and ${red} of them said Don't fly. Counted with Tiger Data.`
}).catch(() => {})

// ---- sections rise in as you scroll to them
const reveal = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); reveal.unobserve(e.target) }
}, { threshold: 0.15 })
document.querySelectorAll('.info section').forEach((s) => { s.classList.add('reveal'); reveal.observe(s) })

// ---- below the hero, the mouse cursor becomes a spinning propeller (mouse and trackpad only)
const hero = document.getElementById('hero')
const below = () => document.body.classList.toggle('below-hero', scrollY > hero.offsetHeight * 0.6)
addEventListener('scroll', below, { passive: true })
below()
if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
  const c = document.createElement('div')
  c.className = 'prop-cursor'
  c.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true">
    <path d="M20 20 C 15 17, 6 15, 3 18 C 1 20, 4 22, 9 22 C 14 22, 18 21, 20 20 Z" fill="#e8ebef"/>
    <path d="M20 20 C 25 23, 34 25, 37 22 C 39 20, 36 18, 31 18 C 26 18, 22 19, 20 20 Z" fill="#e8ebef"/>
    <circle cx="20" cy="20" r="3.2" fill="#b59a3a"/></svg>`
  document.body.append(c)
  addEventListener('pointermove', (e) => {
    c.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`
    const over = e.target.closest && e.target.closest('a, button')
    c.classList.toggle('fast', !!over)
    c.classList.toggle('big', !!over)
  }, { passive: true })
}
