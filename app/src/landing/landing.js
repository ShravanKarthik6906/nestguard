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

// ---- words whoosh into place, one after another, as each heading and paragraph scrolls into view
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

// Wrap every word in a span. Links and bold text stay intact; live values that load later are left alone.
function splitWords(el) {
  let count = 0
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const frag = document.createDocumentFragment()
        for (const part of child.textContent.split(/(\s+)/)) {
          if (!part) continue
          if (/^\s+$/.test(part)) { frag.append(document.createTextNode(part)); continue }
          const w = document.createElement('span')
          w.className = 'w'
          w.textContent = part
          w.style.setProperty('--i', count++)
          frag.append(w)
        }
        child.replaceWith(frag)
      } else if (child.nodeType === 1 && !child.id?.startsWith('live-')) walk(child)
    }
  }
  walk(el)
  return count
}

const blocks = [...document.querySelectorAll('.info h2, .info section > p, .info .label')]
if (!reduceMotion) {
  for (const b of blocks) {
    const n = splitWords(b)
    b.classList.add('fly')
    b.style.setProperty('--step', `${Math.min(45, 950 / Math.max(1, n)).toFixed(1)}ms`) // words sweep in over about a second
  }
}
// Each heading, paragraph and drawing starts its whoosh on its own, once it is a third of the way up the
// screen, so the motion is seen instead of finishing before it scrolls into view.
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue
    e.target.classList.add('in')
    seen.unobserve(e.target)
  }
}, { rootMargin: '0px 0px -30% 0px', threshold: 0 })
document.querySelectorAll('.info section').forEach((sec) => {
  sec.classList.add('reveal')
  for (const el of sec.children) seen.observe(el)
})

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
