// Connection and backup status for the offline screen. Reads what the app already stores:
// cached API responses (localStorage "ng:/..."), their save times, sample (mock) mode and voice clips.
import { USE_MOCK } from '../config.js'

export function cacheInfo() {
  let entries = 0, last = 0
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k.startsWith('ng:/check') || k.startsWith('ng:/zones') || k.startsWith('ng:/powerlines')) entries++
      if (k.startsWith('ng:t:')) last = Math.max(last, Number(localStorage.getItem(k)) || 0)
    }
  } catch {}
  return { entries, last: last || null }
}

export const status = () => ({
  online: navigator.onLine,
  sample: USE_MOCK,
  ...cacheInfo(),
})

export function ago(t) {
  if (!t) return 'never'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(t).toLocaleString()
}
