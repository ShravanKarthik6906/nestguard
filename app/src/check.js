import { sortHazards, hazardRow } from './hazards.js'
import { band, mainDriver } from './risk.js'

const $ = (id) => document.getElementById(id)

export function showLoading() {
  const b = $('banner')
  if (b.classList.contains('none')) b.className = 'verdict skeleton'
  else b.classList.add('loading')
}

function items(list, make) {
  return list.map((x) => { const li = document.createElement('li'); make(li, x); return li })
}

export function showCheck(r) {
  // the score is the headline: "Risk 49 / 100", coloured by band (>= 60 high, >= 30 medium)
  const bd = band(r.score)
  $('banner').className = 'verdict score ' + bd.cls
  $('banner').innerHTML = '<span class="risk-label">Risk</span> <span class="risk-num"></span><span class="risk-of">/100</span> <span class="risk-band"></span>'
  $('banner').querySelector('.risk-num').textContent = Number.isFinite(Number(r.score)) ? Math.round(r.score) : 'Not available'
  $('banner').querySelector('.risk-band').textContent = bd.cls === 'none' ? '' : `${bd.word} risk`
  $('message').textContent = mainDriver(r.message)
  $('bird-row').hidden = typeof r.bird_score !== 'number'
  $('bird-score').textContent = r.bird_score ?? ''
  $('best-time').textContent = r.best_time || 'Not available'
  const sp = r.safer_spot
  $('safer-row').hidden = !sp
  $('safer').textContent = sp ? (sp.label || `${sp.distance_km} km ${sp.direction}: risk ${sp.score}`) : ''

  $('raptor').hidden = !r.raptor_alert
  $('raptor-text').textContent = r.raptor_alert || ''
  const hz = sortHazards(r.hazards)
  $('hazards').replaceChildren(...hz.map(hazardRow))
  $('hazards').hidden = hz.length === 0
  $('reasons').replaceChildren(...items(r.reasons || [], (li, t) => { li.textContent = t }))
  $('reasons-block').hidden = hz.length > 0 || !(r.reasons || []).length // hazards replace the plain list
  $('result').hidden = false
}

// why: undefined = loading (skeleton), null/'' = hide, string = show
export function showWhy(why) {
  $('why-block').hidden = why === null || why === ''
  $('why-block').classList.toggle('skeleton', why === undefined)
  $('why').textContent = why || ''
}

export function showCheckError(msg) {
  $('banner').className = 'verdict none'
  $('banner').textContent = 'No result'
  $('message').textContent = msg
  $('bird-row').hidden = true
  $('safer-row').hidden = true
  $('best-time').textContent = 'Not available'
  $('raptor').hidden = true
  $('reasons').replaceChildren()
  $('hazards').replaceChildren()
  $('hazards').hidden = true
  showWhy(null)
  $('result').hidden = false
}
