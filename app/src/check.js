const $ = (id) => document.getElementById(id)
const LABELS = { green: 'Go', yellow: 'Wait', red: "Don't fly" }
const CHECKS = [['wildlife', 'Wildlife'], ['safety', 'Drone safety'], ['legal', 'FAA legal']]

export function showLoading() {
  $('banner').classList.add('loading')
}

function list(items) {
  return items.map((t) => {
    const li = document.createElement('li')
    li.textContent = t
    return li
  })
}

export function showCheck(r) {
  const level = LABELS[r.level] ? r.level : 'yellow'
  $('banner').className = 'banner ' + level
  $('banner').textContent = LABELS[level]
  $('message').textContent = r.message || ''
  $('score').textContent = r.score ?? '—'
  $('best-time').textContent = r.best_time || '—'

  // The three checks: Wildlife / Drone safety / FAA legal
  $('checks').replaceChildren(...(r.checks ? CHECKS : []).map(([key, name]) => {
    const span = document.createElement('span')
    span.className = 'check ' + (r.checks[key] || 'none')
    span.textContent = name
    return span
  }))

  $('raptor').hidden = !r.raptor_alert
  $('raptor').textContent = r.raptor_alert ? '🦅 ' + r.raptor_alert : ''
  $('reasons').replaceChildren(...list(r.reasons || []))
  $('result').hidden = false
}

// why: undefined = loading, null/'' = hide, string = show
export function showWhy(why) {
  $('why').hidden = why === null || why === ''
  $('why').classList.toggle('loading', why === undefined)
  $('why').textContent = why === undefined ? 'Asking Gemini why…' : why || ''
}

export function showCheckError(msg) {
  $('banner').className = 'banner none'
  $('banner').textContent = 'No result'
  $('message').textContent = msg
  $('score').textContent = '—'
  $('best-time').textContent = '—'
  $('checks').replaceChildren()
  $('raptor').hidden = true
  $('reasons').replaceChildren()
  showWhy(null)
  $('result').hidden = false
}
