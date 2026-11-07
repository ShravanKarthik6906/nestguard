const $ = (id) => document.getElementById(id)
const LABELS = { green: 'Go', yellow: 'Wait', red: "Don't fly" }

export function showLoading() {
  $('banner').classList.add('loading')
}

export function showCheck(r) {
  const level = LABELS[r.level] ? r.level : 'yellow'
  $('banner').className = 'banner ' + level
  $('banner').textContent = LABELS[level]
  $('message').textContent = r.message || ''
  $('score').textContent = r.score ?? '—'
  $('reasons').replaceChildren(...(r.reasons || []).map((t) => {
    const li = document.createElement('li')
    li.textContent = t
    return li
  }))
  $('result').hidden = false
}

export function showCheckError(msg) {
  $('banner').className = 'banner none'
  $('banner').textContent = 'No result'
  $('message').textContent = msg
  $('score').textContent = '—'
  $('reasons').replaceChildren()
  $('result').hidden = false
}
