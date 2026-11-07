import { USE_MOCK } from './config.js'

// Speaks the check result out loud when the level changes.
// Order: pre-generated clip (offline, free) -> /speak (Fish Audio via our backend)
// -> generic clip for the level. The browser never sees the Fish Audio key.

const LABELS = { green: 'Go', yellow: 'Wait', red: "Don't fly" }
const FALLBACK = { green: 'Go. Clear to fly.', yellow: 'Wait. Check the warnings before you fly.', red: "Don't fly." }

const audio = new Audio()
const urls = new Map() // spoken text -> playable URL
let clips = {}
let lastLevel = null

fetch('/audio/clips.json').then((r) => r.json()).then((c) => { clips = c }).catch(() => {})

// iPhone Safari only plays sound after a tap. Play a silent sound on the first
// tap so the same <audio> element can speak later on its own.
function unlock() {
  audio.src = silentWav()
  audio.play().catch(() => {})
  window.removeEventListener('pointerdown', unlock)
}
window.addEventListener('pointerdown', unlock)

// Same rule as backend/make_clips.py: say the level first unless the message already does.
export function spokenText(level, message) {
  const label = LABELS[level] || 'Wait'
  const m = (message || '').trim()
  return m.toLowerCase().startsWith(label.toLowerCase()) ? m : `${label}. ${m}`.trim()
}

async function urlFor(text) {
  if (urls.has(text)) return urls.get(text)
  if (clips[text]) return '/audio/' + clips[text]
  if (USE_MOCK) return null
  const res = await fetch('/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const url = URL.createObjectURL(await res.blob())
  urls.set(text, url)
  return url
}

async function play(url) {
  audio.pause()
  audio.src = url
  await audio.play()
}

export async function announce(result) {
  if (!result || result.level === lastLevel) return
  lastLevel = result.level
  const text = spokenText(result.level, result.message)
  try {
    const url = await urlFor(text)
    if (!url) throw new Error('no clip')
    if (lastLevel === result.level) await play(url) // skip if the level changed while loading
  } catch (err) {
    const name = clips[FALLBACK[result.level]]
    if (name && lastLevel === result.level) play('/audio/' + name).catch(() => {})
    console.warn('speech:', err.message)
  }
}

function silentWav() {
  const b = new Uint8Array(46)
  const v = new DataView(b.buffer)
  const s = (o, t) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)))
  s(0, 'RIFF'); v.setUint32(4, 38, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true)
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true)
  v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  s(36, 'data'); v.setUint32(40, 2, true)
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }))
}
