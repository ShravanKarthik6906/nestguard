const $ = (id) => document.getElementById(id)
const LABELS = { green: 'Go', yellow: 'Wait', red: "Don't fly" }
const CHECKS = [['safety', 'Drone safety'], ['legal', 'FAA legal'], ['wildlife', 'Wildlife']]
const STATES = { green: 'Clear', yellow: 'Caution', red: 'Fail' }

// The banner already says the verdict, so drop a repeated "Don't fly:" or "Wait:" from the message.
const cleanMessage = (m = '') => m.replace(/^(don't fly|wait|go)\s*[:.,-]\s*/i, '').replace(/^./, (c) => c.toUpperCase())

export function showLoading() {
  const b = $('banner')
  if (b.classList.contains('none')) b.className = 'verdict skeleton'
  else b.classList.add('loading')
}

function items(list, make) {
  return list.map((x) => { const li = document.createElement('li'); make(li, x); return li })
}

export function showCheck(r) {
  const level = LABELS[r.level] ? r.level : 'yellow'
  $('banner').className = 'verdict ' + level
  $('banner').textContent = LABELS[level]
  $('message').textContent = cleanMessage(r.message)
  $('score').textContent = r.score ?? 'Not available'
  $('bird-row').hidden = typeof r.bird_score !== 'number'
  $('bird-score').textContent = r.bird_score ?? ''
  $('best-time').textContent = r.best_time || 'Not available'

  $('checks').replaceChildren(...items(r.checks ? CHECKS : [], (li, [key, name]) => {
    const lvl = r.checks[key]
    li.innerHTML = '<span></span><span class="state"></span>'
    li.firstChild.textContent = name
    li.lastChild.textContent = STATES[lvl] || 'Not available'
    li.lastChild.classList.add(lvl || 'none')
  }))

  $('raptor').hidden = !r.raptor_alert
  $('raptor-text').textContent = r.raptor_alert || ''
  $('reasons').replaceChildren(...items(r.reasons || [], (li, t) => { li.textContent = t }))
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
  $('score').textContent = 'Not available'
  $('bird-row').hidden = true
  $('best-time').textContent = 'Not available'
  $('checks').replaceChildren()
  $('raptor').hidden = true
  $('reasons').replaceChildren()
  showWhy(null)
  $('result').hidden = false
}
