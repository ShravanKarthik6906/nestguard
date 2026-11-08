// Redesigned pre-flight tool: Location -> Assessment -> Explore, plus the guided demo and Offline & backup.
// Reuses the existing API, map, speech, demo and device modules; only the presentation is new.
import '@fontsource/b612/400.css'
import '@fontsource/b612/700.css'
import '@fontsource/b612-mono/400.css'
import '@fontsource/b612-mono/700.css'
import './pf.css'
import { RPI, USE_MOCK } from '../config.js'
import { getZones, check, explain, getPowerlines, distM } from '../api.js'
import { createMap, drawZones, setPin, setPinRisk, drawPowerlines, showPowerlines, onFeatureClick, drawRoute, clearRoute, getMap, setSaferSpot, frameSpot } from '../map.js'
import { band, mainDriver } from '../risk.js'
import { startDemo, stopDemo, pauseDemo, resumeDemo, stepDemo, isRunning, demoDate, PATH_POINTS } from '../demo.js'
import { announce } from '../speech.js'
import { startTelemetry } from '../telemetry.js'
import { icon, INFO, titleOf, SEVERITY, sortHazards, completeness } from './hazinfo.js'
import { searchPlaces, placeName, parseCoords } from './geocode.js'
import { status as offStatus, ago } from './offline.js'

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const today = () => demoDate()
const fmtDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const state = { spot: null, result: null, source: null, savedAt: null, view: 'setup', prev: 'setup', pick: false, demo: false }
$('date').value = params.get('date') || today()

// ---------- the one map, moved between the preview and the explore screen
const mapEl = $('map')
$('slot-preview').append(mapEl)
const map = createMap(mapEl, RPI)
onFeatureClick('zone', showZone)
onFeatureClick('line', showLine)

// ---------- navigation between screens (hash based, so Back works and nothing reloads)
const VIEWS = ['setup', 'results', 'explore', 'offline']
function go(view, { push = true } = {}) {
  if (view === 'back') { history.back(); return }
  if (!VIEWS.includes(view)) view = 'setup'
  if ((view === 'results' || view === 'explore') && !state.spot) view = 'setup'
  if (view !== state.view) state.prev = state.view
  state.view = view
  for (const v of VIEWS) $('v-' + v).hidden = v !== view
  // the map lives on the assessment as a preview and on the explore screen full size
  if (view === 'explore') $('slot-explore').append(mapEl)
  else if (view === 'results') $('slot-preview').append(mapEl)
  // after the map moves to its new box: re-measure, then frame the route (demo) or centre on the spot
  setTimeout(() => {
    map.invalidateSize()
    if (state.demo) map.fitBounds(PATH_POINTS().map((p) => [p.lat, p.lon]), { padding: [50, 50] })
    else if (state.spot && !state.pick && (view === 'explore' || view === 'results')) frameSpot(state.spot.lat, state.spot.lon)
  }, 80)
  document.body.classList.toggle('explore-mode', view === 'explore')
  document.body.classList.toggle('results-mode', view === 'results')
  document.querySelectorAll('.step').forEach((b) => {
    b.toggleAttribute('aria-current', b.dataset.go === view)
    if (b.dataset.go === view) b.setAttribute('aria-current', 'step')
  })
  if (view === 'offline') renderOffline()
  if (push && location.hash !== '#' + view) history.pushState({ view }, '', location.pathname + location.search + '#' + view)
  const h = document.querySelector(`#v-${view} h1`)
  if (h) h.focus({ preventScroll: true })
  scrollTo({ top: 0 })
}
addEventListener('popstate', () => go(location.hash.slice(1) || 'setup', { push: false }))
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-go]')
  if (t && !t.disabled) { e.preventDefault(); go(t.dataset.go) }
})
const unlockSteps = () => document.querySelectorAll('.step').forEach((b) => (b.disabled = b.dataset.go !== 'setup' && !state.spot))

// ---------- 1. location and date
let picked = null
function choose(place) {
  picked = place
  $('sel').hidden = !place
  $('go').disabled = !place
  if (place) {
    $('sel-name').textContent = place.name
    $('sel-coords').textContent = `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`
    $('q').value = place.name
    setMsg('')
  }
}
function setMsg(t, err = false) { $('setup-msg').textContent = t; $('setup-msg').classList.toggle('err', err) }

// search with suggestions (keyboard: up / down / enter / escape)
let searchCtl, searchTimer, items = [], active = -1
function renderSuggest(list, hint) {
  items = list; active = -1
  const ul = $('q-list')
  ul.innerHTML = list.map((p, i) => `<li role="option" id="q-o${i}" aria-selected="false">${esc(p.name)}</li>`).join('') +
    (hint ? `<li class="hint" role="presentation">${esc(hint)}</li>` : '')
  ul.hidden = !list.length && !hint
  $('q').setAttribute('aria-expanded', String(!ul.hidden))
  $('q').setAttribute('aria-activedescendant', '')
}
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer)
  const text = $('q').value
  choose(null); $('go').disabled = true
  const c = parseCoords(text)
  if (c) return renderSuggest([c])
  if (text.trim().length < 3) return renderSuggest([])
  searchTimer = setTimeout(async () => {
    searchCtl?.abort(); searchCtl = new AbortController()
    const c = map.getCenter() // results near the area you are looking at come first
    try { renderSuggest(await searchPlaces(text, searchCtl.signal, { lat: c.lat, lon: c.lng }), '') }
    catch (err) { if (err.name !== 'AbortError') renderSuggest([], navigator.onLine ? 'Place search is unavailable right now. Type coordinates, or use your location or the map.' : 'You are offline. Type coordinates, or open a place you checked before.') }
  }, 250)
})
$('q').addEventListener('keydown', (e) => {
  if ($('q-list').hidden || !items.length) { if (e.key === 'Enter' && picked) runFromSetup(); return }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    active = active < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
    $('q-list').querySelectorAll('[role=option]').forEach((li, i) => li.setAttribute('aria-selected', String(i === active)))
    $('q').setAttribute('aria-activedescendant', 'q-o' + active)
  } else if (e.key === 'Enter') { e.preventDefault(); pickSuggestion(Math.max(0, active)) }
  else if (e.key === 'Escape') renderSuggest([])
})
$('q-list').addEventListener('mousedown', (e) => {
  const li = e.target.closest('[role=option]')
  if (li) { e.preventDefault(); pickSuggestion([...$('q-list').querySelectorAll('[role=option]')].indexOf(li)) }
})
$('q').addEventListener('blur', () => setTimeout(() => renderSuggest([]), 150))
function pickSuggestion(i) { if (items[i]) { choose(items[i]); renderSuggest([]) } }

$('use-loc').addEventListener('click', () => {
  if (!navigator.geolocation || !window.isSecureContext) return setMsg('Your location needs a secure (https) connection. Search for a place or choose on the map instead.', true)
  setMsg('Finding your location…')
  navigator.geolocation.getCurrentPosition(async (p) => {
    const lat = p.coords.latitude, lon = p.coords.longitude
    choose({ lat, lon, name: 'Your current location' })
    choose({ lat, lon, name: await placeName(lat, lon) })
  }, (err) => setMsg('Could not get your location: ' + err.message, true), { enableHighAccuracy: true, timeout: 10000 })
})

// "Choose on the map": open the big map in pick mode; a tap sets the spot and returns here
let pickBanner
$('pick-map').addEventListener('click', () => {
  state.pick = true
  state.spot = state.spot || { ...RPI, name: '' }
  go('explore')
  pickBanner = Object.assign(document.createElement('div'), { className: 'pick-banner', textContent: 'Tap the map to choose your spot' })
  $('slot-explore').append(pickBanner)
})

$('go').addEventListener('click', runFromSetup)
function runFromSetup() {
  if (!picked) return
  scenarioKey = null
  state.spot = { ...picked }
  runCheck({ speak: true, why: true })
  go('results')
}

// ---------- the check (same calls and rules as before)
let checkId = 0
async function runCheck({ speak = true, why = speak } = {}) {
  const { lat, lon } = state.spot
  const id = ++checkId
  unlockSteps()
  setPin(lat, lon)
  renderLoading()
  if (state.view !== 'explore') map.setView([lat, lon], 14)
  try {
    const { data, source, savedAt } = await check(lat, lon, $('date').value, 30000)
    if (id !== checkId) return
    Object.assign(state, { result: data, source, savedAt })
    renderResult(data)
    setPinRisk(band(data.score).cls)
    if (Array.isArray(data.zones) && data.zones.length) drawZones(data.zones)
    announce(data, { force: speak })
    if (why) loadWhy(id); else $('r-why').hidden = true
  } catch (err) {
    if (id === checkId) renderError(err)
  }
  updateConn()
  loadZonesSoon()
  loadPowerlines(true)
}

async function loadWhy(id) {
  $('r-why').hidden = false; $('r-why').classList.add('loading'); $('r-why-t').textContent = ''
  try {
    const { data } = await explain(state.spot.lat, state.spot.lon, $('date').value)
    if (id !== checkId) return
    $('r-why').classList.remove('loading')
    if (data.why) $('r-why-t').textContent = data.why; else $('r-why').hidden = true
  } catch { if (id === checkId) $('r-why').hidden = true }
}

// ---------- 2. the assessment
let slowTimer
const CONCERN = { red: 'High concern', yellow: 'Moderate concern', green: 'Low concern', none: 'Score unavailable' }
function renderLoading() {
  $('res-h').textContent = `${state.spot.name || 'Selected spot'} · ${fmtDate($('date').value)}`
  $('r-assess').className = 'assess loading'
  $('r-concern').textContent = 'Checking'
  $('r-score').textContent = '--'; $('r-meter').style.width = '0'
  $('r-summary').textContent = 'Checking weather, birds, power lines and more…'
  clearTimeout(slowTimer)
  slowTimer = setTimeout(() => { if ($('r-assess').classList.contains('loading')) $('r-summary').textContent = 'Still checking. The first check in a new area can take up to 20 seconds while NestGuard gathers bird and power-line data.' }, 4000)
  renderContext()
  $('r-error').hidden = true; $('r-saved').hidden = true
}

function summarize(hz) {
  const red = hz.filter((h) => h.level === 'red'), mid = hz.filter((h) => h.level === 'yellow')
  if (red.length >= 2) return `Several serious hazards detected: ${red.map((h) => titleOf(h.type).toLowerCase()).join(', ')}.`
  if (red.length === 1) return `One serious hazard detected: ${titleOf(red[0].type).toLowerCase()}${mid.length ? `, plus ${mid.length} to keep an eye on` : ''}.`
  if (mid.length) return `No serious hazards, but ${mid.length} thing${mid.length > 1 ? 's' : ''} to keep an eye on.`
  return 'No significant hazards detected in the data we have.'
}

function renderResult(r) {
  const bd = band(r.score)
  const hz = sortHazards(r.hazards)
  $('r-assess').className = 'assess ' + bd.cls
  $('r-concern').textContent = CONCERN[bd.cls]
  const n = Number.isFinite(Number(r.score)) ? Math.round(r.score) : null
  $('r-score').textContent = n ?? '--'
  $('r-meter').style.width = (n ?? 0) + '%'
  $('r-summary').textContent = hz.length ? summarize(hz) : mainDriver(r.message)

  // cached copies are never shown as live
  if (state.source === 'cached') {
    $('r-saved').hidden = false
    $('r-saved').textContent = `You are seeing a saved copy${state.savedAt ? ` from ${ago(state.savedAt)} (${new Date(state.savedAt).toLocaleString()})` : ''}, because the live service did not answer. It may be out of date.`
  } else if (state.source === 'mock') {
    $('r-saved').hidden = false
    $('r-saved').textContent = 'Sample data: this is a built-in example, not live conditions.'
  }

  // completeness: missing sources are shown as missing, never as safe
  const c = completeness(r.hazards)
  $('r-complete').innerHTML = c.total
    ? `Assessment completeness: <b>${c.available} of ${c.total}</b> data sources available.` +
      (c.missing.length ? ` No data for ${esc(c.missing.map((h) => titleOf(h.type).toLowerCase()).join(', '))}. Missing data is never counted as safe, so check those yourself.` : '')
    : ''

  $('r-hazards').replaceChildren(...(hz.length ? hz.map(hazardItem) : (r.reasons || []).map((t) => {
    const li = document.createElement('li'); li.innerHTML = `<details><summary>${icon('info')}<span><span class="t"></span></span><span></span></summary></details>`
    li.querySelector('.t').textContent = t; return li
  })))

  const facts = []
  if (r.raptor_alert) facts.push(['Hawk alert', r.raptor_alert])
  if (r.best_time) facts.push(['Best time to fly', r.best_time])
  if (typeof r.bird_score === 'number') facts.push(['Bird risk only', `${r.bird_score}/100`])
  $('r-facts').innerHTML = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')
  renderSafer(r, hz)
  renderSpotSummary()
}

// "Is there a lower-risk spot nearby?" Uses the API's safer_spot; when there is none, say why.
const AREA_WIDE = ['migration', 'wind', 'rain', 'clouds', 'visibility', 'air']
function renderSafer(r, hz) {
  const sp = r.safer_spot
  const placed = sp && Number.isFinite(sp.lat) && Number.isFinite(sp.lon)
  setSaferSpot(placed ? sp : null, () => goToSafer(sp))
  if (sp) {
    $('r-safer').innerHTML = `<div class="safer-card"><span class="safer-k">Lower-risk spot nearby</span>` +
      `<p class="safer-main"><span class="safer-num mono">${esc(sp.score)}</span><span class="of mono">/100</span>` +
      `<span class="safer-where">${esc(sp.distance_km != null ? `${sp.distance_km} km ${sp.direction}` : (sp.label || ''))}</span></p>` +
      (sp.note ? `<p class="safer-n">${esc(sp.note)}</p>` : '') +
      (placed ? '<button class="btn primary" type="button" id="safer-go">Check this spot</button><span class="safer-hint">Also marked on the map</span>' : '') + '</div>'
    if (placed) {
      $('safer-go').addEventListener('click', () => goToSafer(sp))
      if (state.view !== 'setup' && state.spot) frameSpot(state.spot.lat, state.spot.lon)
    }
    return
  }
  const head = '<p class="safer-t"><b>Lower-risk spot nearby</b> '
  if (r.bird_score == null) { $('r-safer').innerHTML = head + 'Cannot compare nearby spots: there is no bird data for this area.</p>'; return }
  if (band(r.score).cls === 'green') { $('r-safer').innerHTML = head + 'This spot is already low risk.</p>'; return }
  const wide = hz.filter((h) => AREA_WIDE.includes(h.type) && (h.level === 'red' || h.level === 'yellow'))
  $('r-safer').innerHTML = head + 'Nothing within 3 km scores lower, so this is about as good as it gets nearby.' +
    (wide.length ? ` The main concern (${esc(wide.map((h) => titleOf(h.type).toLowerCase()).join(', '))}) covers the whole area.` : '') +
    (r.best_time ? ` A better time: ${esc(r.best_time)}.` : '') + '</p>'
}
function goToSafer(sp) {
  scenarioKey = null
  state.spot = { lat: sp.lat, lon: sp.lon, name: `Lower-risk spot, ${sp.distance_km} km ${sp.direction}` }
  runCheck({ speak: true, why: true })
  if (state.view !== 'results') go('results')
}

function hazardItem(h) {
  const sev = SEVERITY[h.level] || SEVERITY.unknown
  const li = document.createElement('li')
  li.className = { red: 'high', yellow: 'mid', green: 'low', unknown: 'none' }[h.level]
  const detail = h.level === 'unknown' ? 'No data for this spot right now' : h.detail || ''
  const why = INFO[h.type]?.why || ''
  li.innerHTML = `<details><summary>${icon(h.type)}<span><span class="t">${esc(titleOf(h.type))}</span><span class="d">${esc(detail)}</span></span>` +
    `<span class="sev ${sev.cls}">${sev.label}</span></summary><div class="exp">` +
    (h.level === 'unknown' ? '<p>This source did not return data for this spot, so NestGuard cannot tell whether this hazard is present. Treat it as unknown, not as safe.</p>' : '') +
    `<p>${esc(why)}</p>` + (h.type === 'powerlines' ? '<p>Open the map to see the mapped lines around your spot.</p>' : '') + '</div></details>'
  return li
}

function renderError(err) {
  $('r-assess').className = 'assess'
  $('r-concern').textContent = 'No assessment'
  $('r-score').textContent = '--'
  $('r-summary').textContent = ''
  $('r-hazards').replaceChildren(); $('r-facts').innerHTML = ''; $('r-complete').textContent = ''; $('r-why').hidden = true; $('r-safer').innerHTML = ''; setSaferSpot(null)
  $('r-error').hidden = false
  const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError' || /abort/i.test(err.message)
  $('r-error').innerHTML = (timedOut ? 'The check took too long. ' : `Could not get an assessment for this spot (${esc(err.message)}). `) +
    (navigator.onLine ? 'The service may be busy; try again in a moment.' : 'You are offline, and there is no saved copy for this spot and date.') +
    ' <button class="btn" type="button" id="retry">Try again</button> <button class="btn ghost" type="button" data-go="offline">Offline and backup</button>'
  $('retry').addEventListener('click', () => runCheck({ speak: true, why: true }))
}

// ---------- 3. explore: layers, legend and explanations
let zoneTimer, zonesOn = true
async function loadZones() {
  if (!state.spot) return
  const c = map.getCenter()
  const radiusKm = Math.min(50, Math.max(5, c.distanceTo(map.getBounds().getNorthEast()) / 1000))
  try {
    const { data } = await getZones(c.lat, c.lng, radiusKm, $('date').value, 20000)
    drawZones(zonesOn ? data : [])
  } catch {}
}
const loadZonesSoon = () => { clearTimeout(zoneTimer); zoneTimer = setTimeout(loadZones, 300) }
map.on('moveend', loadZonesSoon)
$('lay-zones').addEventListener('change', (e) => { zonesOn = e.target.checked; loadZones() })

// power lines: same rules as before (refetch after large moves, hidden when zoomed far out, choice remembered)
let powerAt = null, powerTimer
async function loadPowerlines(force = false) {
  const c = map.getCenter(), z = map.getZoom()
  if (z < 12) { drawPowerlines([]); powerAt = null; $('power-note').textContent = 'Zoom in to see power lines'; return }
  const radiusKm = Math.min(3, Math.max(1, Math.round(c.distanceTo(map.getBounds().getNorthEast()) / 1000)))
  if (!force && powerAt && powerAt.r === radiusKm && c.distanceTo(powerAt.c) < radiusKm * 1000 * 0.4) return
  powerAt = { c, r: radiusKm }
  try {
    const { data } = await getPowerlines(c.lat, c.lng, radiusKm)
    drawPowerlines(Array.isArray(data) ? data : [])
    $('power-note').textContent = Array.isArray(data) && !data.length ? 'No mapped power lines in this view. Unmapped lines may still exist.' : ''
  } catch { powerAt = null; $('power-note').textContent = 'Power line data is unavailable right now.' }
}
map.on('moveend', () => { clearTimeout(powerTimer); powerTimer = setTimeout(() => loadPowerlines(), 500) })
let powerOn = true
try { powerOn = localStorage.getItem('ng:power') !== 'off' } catch {}
$('power-toggle').checked = powerOn
showPowerlines(powerOn)
$('power-toggle').addEventListener('change', (e) => {
  showPowerlines(e.target.checked)
  try { localStorage.setItem('ng:power', e.target.checked ? 'on' : 'off') } catch {}
})

function distanceText(m) { return m < 1000 ? `about ${Math.round(m / 10) * 10} m` : m < 10000 ? `about ${(m / 1000).toFixed(1)} km` : `about ${Math.round(m / 1000)} km` }

function showZone(z) {
  const risk = typeof z.risk === 'number' ? z.risk : null
  const bd = band(risk)
  const d = state.spot ? distM(state.spot.lat, state.spot.lon, z.lat, z.lon) : null
  $('feat').innerHTML = `<h3>${icon('zone')} Bird activity area</h3>
    <dl>
      <div><dt>Bird activity</dt><dd>${risk === null ? 'Not available' : `${esc(bd.word)} (${risk}/100)`}</dd></div>
      <div><dt>Size</dt><dd>About ${Math.round((z.radius_m || 500) * 2 / 100) / 10} km across</dd></div>
      <div><dt>From your spot</dt><dd>${d === null ? 'Not available' : distanceText(d)}</dd></div>
      <div><dt>Accuracy</dt><dd>Approximate, on a grid of about 1 km</dd></div>
      <div><dt>Sightings and last update</dt><dd>Not provided for individual areas</dd></div>
    </dl>
    <p><b>What it is.</b> Birds were reported in this area. The circle is deliberately blurred to about 1 km so it can never be used to find nests.</p>
    <p><b>Why it matters.</b> More bird activity means a higher chance of disturbing birds or a collision, especially in nesting and migration seasons.</p>
    <p class="muted">This is an area of environmental concern, not an official no-fly zone.</p>`
}

function lineDistance(line) {
  if (!state.spot) return null
  const { lat, lon } = state.spot, k = Math.cos((lat * Math.PI) / 180)
  const xy = ([a, b]) => [(b - lon) * 111320 * k, (a - lat) * 110540]
  let best = Infinity
  const pts = line.coords.map(xy)
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy))
  }
  return best
}
function showLine(l) {
  const kind = l.kind === 'minor_line' ? 'Local distribution line (smaller wires along streets)' : l.kind === 'line' ? 'Transmission line (large high-voltage wires on tall towers)' : 'Power line'
  const v = Number(String(l.voltage || '').split(';')[0])
  const volts = Number.isFinite(v) && v > 0 ? `${v >= 1000 ? Math.round(v / 1000) + ' kilovolts (kV)' : v + ' volts'}` : 'Not recorded'
  const d = lineDistance(l)
  const near = d !== null && d <= 100 ? 'High: very close to your spot' : d !== null && d <= 300 ? 'Moderate: within 300 m' : 'Low: farther than 300 m'
  $('feat').innerHTML = `<h3>${icon('powerlines')} Power line</h3>
    <dl>
      <div><dt>Type</dt><dd>${esc(kind)}</dd></div>
      <div><dt>Voltage</dt><dd>${esc(volts)}</dd></div>
      <div><dt>From your spot</dt><dd>${d === null ? 'Not available' : distanceText(d)}</dd></div>
      <div><dt>Concern</dt><dd>${d === null ? 'Not available' : near}</dd></div>
      <div><dt>Source</dt><dd>OpenStreetMap</dd></div>
    </dl>
    <p>${esc(INFO.powerlines.why)}</p>`
}

function renderSpotSummary() {
  const r = state.result
  if (!state.spot) return
  const bd = band(r && r.score)
  $('exp-spot').innerHTML = r ? `Your spot: <b>${esc(state.spot.name || 'selected spot')}</b>, risk <b class="mono">${Math.round(r.score)}/100</b> (${esc(bd.word.toLowerCase())})` : ''
  const sp = r && r.safer_spot
  const box = $('exp-safer')
  box.hidden = !(sp && Number.isFinite(sp.lat))
  if (box.hidden) return
  box.innerHTML = `<span class="safer-k">Lower-risk spot nearby</span><p class="safer-main"><span class="safer-num mono">${esc(sp.score)}</span><span class="of mono">/100</span>` +
    `<span class="safer-where">${esc(sp.distance_km)} km ${esc(sp.direction)}</span></p><button class="btn primary" type="button">Check this spot</button>`
  box.querySelector('button').addEventListener('click', () => goToSafer(sp))
}

// tapping the map: choose a spot (pick mode) or check that spot
map.on('click', async (e) => {
  const { lat, lng: lon } = e.latlng
  if (state.pick) {
    state.pick = false; pickBanner?.remove()
    choose({ lat, lon, name: `${lat.toFixed(4)}, ${lon.toFixed(4)}` })
    go('setup')
    choose({ lat, lon, name: await placeName(lat, lon) })
    return
  }
  if (state.view !== 'explore' || state.demo) return
  scenarioKey = null
  state.spot = { lat, lon, name: `${lat.toFixed(4)}, ${lon.toFixed(4)}` }
  runCheck({ speak: true, why: true })
  state.spot.name = await placeName(lat, lon)
  renderSpotSummary(); $('res-h').textContent = `${state.spot.name} · ${fmtDate($('date').value)}`
})

// ---------- guided demo walkthrough (same route, checks and device updates as before)
const pts = PATH_POINTS()
$('demo-dots').innerHTML = pts.map(() => '<i></i>').join('')
let demoFirst = null
function startWalk() {
  scenarioKey = null
  $('date').value = today()
  state.demo = true; demoFirst = null
  state.spot = { ...pts[0], name: 'Demo route, Troy' }
  unlockSteps()
  go('explore')
  $('demo-panel').hidden = false; $('demo-end').hidden = true
  $('demo-play').textContent = 'Pause'
  drawRoute(pts, 0)
  startDemo(onDemoPoint, (msg) => { $('demo-device').textContent = msg }, onDemoEnd)
}
function onDemoPoint(p, i, n) {
  state.spot = { lat: p.lat, lon: p.lon, name: `Demo route, step ${i + 1} of ${n}` }
  $('demo-step').textContent = `Step ${i + 1} of ${n}`
  $('demo-dots').querySelectorAll('i').forEach((d, k) => { d.className = k < i ? 'done' : k === i ? 'now' : '' })
  drawRoute(pts, i)
  $('demo-now').innerHTML = '<p class="muted">Checking this spot…</p>'
  $('demo-prev').disabled = i === 0; $('demo-next').disabled = i === n - 1
  runCheck({ speak: i === 0, why: false }).then(() => {
    const r = state.result; if (!r) return
    if (i === 0) demoFirst = r.score
    const bd = band(r.score), top = sortHazards(r.hazards).find((h) => h.level !== 'green' && h.level !== 'unknown')
    $('demo-now').innerHTML = `<div class="ds"><span class="mono">${Math.round(r.score)}</span><span class="muted">/100 · ${esc(CONCERN[bd.cls].toLowerCase())}</span></div>` +
      `<p>${esc(top ? `${titleOf(top.type)}: ${top.detail}` : mainDriver(r.message))}</p>`
  })
}
function onDemoEnd() {
  $('demo-play').textContent = 'Play'
  const r = state.result
  $('demo-end').hidden = false
  $('demo-end').innerHTML = `<h3>Walkthrough complete</h3><p>From RPI campus${demoFirst !== null ? ` (risk ${Math.round(demoFirst)})` : ''} to the end of the route${r ? ` (risk ${Math.round(r.score)})` : ''}. The device stays on this last step until you end the demo.</p>` +
    '<div class="row"><button class="btn" type="button" id="demo-replay">Replay</button><button class="btn" type="button" data-go="results">See the full assessment</button></div>'
  $('demo-replay').addEventListener('click', startWalk)
}
async function endWalk() {
  pauseDemo()
  state.demo = false
  $('demo-panel').hidden = true
  clearRoute()
  try { await stopDemo() } catch (err) { $('demo-device').textContent = 'Could not reset the device: ' + err.message }
}
$('demo-open').addEventListener('click', startWalk)
$('demo-play').addEventListener('click', () => {
  if (isRunning()) { pauseDemo(); $('demo-play').textContent = 'Play' }
  else { $('demo-end').hidden = true; resumeDemo(); $('demo-play').textContent = 'Pause' }
})
$('demo-prev').addEventListener('click', () => { stepDemo(-1); $('demo-play').textContent = 'Play'; $('demo-end').hidden = true })
$('demo-next').addEventListener('click', () => { stepDemo(1); $('demo-play').textContent = 'Play' })
$('demo-exit').addEventListener('click', async () => { await endWalk(); go('results') })
setInterval(() => { if (state.demo) $('demo-device').textContent = `Controller device: ${$('device-state').textContent.toLowerCase()}. It follows each step within about 5 seconds.` }, 2000)

// ---------- why a sample place was picked (shown on its assessment)
const CONTEXT = {
  bolsa: 'Why this place? On May 13, 2021, a drone crashed into a nesting colony of terns at Bolsa Chica, California, and about 1,500 eggs were abandoned. This replays the check for that day, to show what NestGuard would have said before that flight.',
  power: 'Why this place? It is about 40 m from a mapped power line in Troy, New York, to show how NestGuard flags wires near your spot.',
  'rpi-may': 'Why this date? May is nesting season, so the same campus spot shows how bird activity changes the assessment.',
}
let scenarioKey = null
function renderContext() {
  const t = scenarioKey && CONTEXT[scenarioKey]
  $('r-context').hidden = !t
  $('r-context').textContent = t || ''
}

// ---------- scenarios (advanced options and ?scenario= links)
const PRESETS = {
  'rpi-today': { lat: 42.7302, lon: -73.6788, date: today, name: 'RPI campus, Troy' },
  'rpi-may': { lat: 42.7302, lon: -73.6788, date: () => '2027-05-15', name: 'RPI campus, Troy' },
  bolsa: { lat: 33.7, lon: -118.04, date: () => '2021-05-13', name: 'Bolsa Chica, California' },
  power: { lat: 42.7493, lon: -73.694138, date: today, name: 'Next to a power line, Troy' },
}
async function runPreset(key) {
  const p = PRESETS[key]; if (!p) return
  if (state.demo) await endWalk()
  scenarioKey = key
  $('date').value = p.date()
  choose({ lat: p.lat, lon: p.lon, name: p.name })
  state.spot = { lat: p.lat, lon: p.lon, name: p.name }
  runCheck({ speak: true, why: true })
  go('results')
}
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => runPreset(b.dataset.preset)))
$('date').addEventListener('change', () => { if (state.spot && state.view !== 'setup') runCheck({ speak: true, why: true }) })

// ---------- offline and backup
function updateConn() {
  const s = offStatus()
  const c = $('conn')
  const kind = s.sample ? 'sample' : !s.online ? 'offline' : state.source === 'cached' ? 'saved' : 'live'
  c.className = 'conn ' + kind
  $('conn-text').textContent = { sample: 'Sample data', offline: 'Offline', saved: 'Saved data', live: 'Live' }[kind]
}
function renderOffline() {
  const s = offStatus()
  $('o-conn').innerHTML = s.online ? '<span class="st">Online</span>' : '<span class="st bad">Offline</span>'
  $('o-source').innerHTML = s.sample ? '<span class="st info">Sample data (built-in examples, not live)</span>'
    : state.source === 'cached' ? '<span class="st warn">A saved copy, possibly out of date</span>'
    : state.source === 'live' ? '<span class="st">Live data</span>' : 'No assessment yet'
  $('o-sync').textContent = s.last ? `${ago(s.last)} (${new Date(s.last).toLocaleString()})` : 'Not yet on this device'
  $('o-backup').textContent = `${s.entries} saved result${s.entries === 1 ? '' : 's'} on this device, plus the built-in sample scenarios and recorded voice alerts`
  $('o-sample').hidden = s.sample; $('o-live').hidden = !s.sample
}
addEventListener('online', () => { updateConn(); if (state.view === 'offline') renderOffline(); if (state.spot && !USE_MOCK) runCheck({ speak: false, why: false }) })
addEventListener('offline', () => { updateConn(); if (state.view === 'offline') renderOffline() })

// ---------- start
startTelemetry()
updateConn()
unlockSteps()
const scen = params.get('scenario')
if (params.get('demo') === 'walk') startWalk()
else if (scen && PRESETS[scen]) runPreset(scen)
else go(location.hash.slice(1) === 'offline' ? 'offline' : 'setup', { push: false })
if (USE_MOCK) document.title += ' (sample data)'
