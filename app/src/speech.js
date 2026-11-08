import { USE_MOCK } from './config.js'
import { band, mainDriver } from './risk.js'

// Speaks the check result out loud: "Risk N. <main driver>".
// Order: pre-generated clip (offline, free) -> /speak (Fish Audio via our backend)
// -> generic clip for the risk band. The browser never sees the Fish Audio key.

const FALLBACK = { green: 'Low risk.', yellow: 'Medium risk.', red: 'High risk.' }

const audio = new Audio()
const urls = new Map() // spoken text -> playable URL
let clips = {}
let lastLevel = null
let speakId = 0 // only the newest announcement plays

fetch('/audio/clips.json').then((r) => r.json()).then((c) => { clips = c }).catch(() => {})

// iPhone Safari only plays sound after a tap. Play a silent sound on the first
// tap so the same <audio> element can speak later on its own.
function unlock() {
  audio.src = silentWav()
  audio.play().catch(() => {})
  window.removeEventListener('pointerdown', unlock)
}
window.addEventListener('pointerdown', unlock)

// Same rule as backend/make_clips.py: "Risk N. <main driver>", with units spelled out for the voice.
const units = (t) => t
  .replace(/\b1\s?km\b/g, '1 kilometer').replace(/(\d)\s?km\b/g, '$1 kilometers')
  .replace(/\b1\s?m\b/g, '1 meter').replace(/(\d)\s?m\b/g, '$1 meters')
  .replace(/\b1\s?ft\b/g, '1 foot').replace(/(\d)\s?ft\b/g, '$1 feet')
export function spokenText(score, message) {
  const n = Number.isFinite(Number(score)) ? Math.round(score) : null
  const driver = units(mainDriver(message).trim().replace(/[.]$/, ''))
  return n === null ? driver : `Risk ${n}. ${driver}`.trim()
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

// force: always speak (someone tapped something). Otherwise only when the risk band changes (demo walk).
export async function announce(result, { force = false } = {}) {
  const bd = band(result && result.score).cls
  if (!result || (!force && bd === lastLevel)) return
  lastLevel = bd
  const id = ++speakId
  const text = spokenText(result.score, result.message)
  try {
    const url = await urlFor(text)
    if (!url) throw new Error('no clip')
    if (id === speakId) await play(url)
  } catch (err) {
    const name = clips[FALLBACK[bd]]
    if (name && id === speakId) play('/audio/' + name).catch(() => {})
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
