// Risk score 0-100 -> band, with the backend's cut-offs: >= 60 high, >= 30 medium, else low.
// Colours reuse the existing red / yellow / green styles.
export function band(score) {
  const s = Number(score)
  if (!Number.isFinite(s)) return { cls: 'none', word: 'Unknown' }
  if (s >= 60) return { cls: 'red', word: 'High' }
  if (s >= 30) return { cls: 'yellow', word: 'Medium' }
  return { cls: 'green', word: 'Low' }
}

// Older responses (and the offline mock files) may still carry a level instead of a risk number.
const FROM_LEVEL = { red: 80, yellow: 45, green: 10 }
export const riskOf = (x) => (typeof x?.risk === 'number' ? x.risk : typeof x?.score === 'number' ? x.score : FROM_LEVEL[x?.level])

// "Risk 49/100: Hawk or eagle sightings within 1 km" -> "Hawk or eagle sightings within 1 km"
export const mainDriver = (message = '') =>
  message.replace(/^risk\s*\d+\s*\/\s*100\s*[:.,-]?\s*/i, '').replace(/^(don't fly|wait|go)\s*[:.,-]\s*/i, '').replace(/^./, (c) => c.toUpperCase())
