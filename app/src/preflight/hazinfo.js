// Plain-English labels, icons and explanations for each hazard the API reports.
// Separate from src/hazards.js on purpose: that module is shared with the landing page.

const ICON = {
  raptors: '<path d="M1.5 7.5c2.5-2.5 4.5-2 6.5 1 2-3 4-3.5 6.5-1"/><path d="M8 8.5v3"/>',
  nesting: '<path d="M2.5 9.5c1.5 3 9.5 3 11 0"/><path d="M3 9.5h10"/><ellipse cx="8" cy="7" rx="2" ry="2.4"/>',
  migration: '<path d="M2 6l2 1.5L6 6M7 10l2 1.5 2-1.5M10 4l2 1.5L14 4"/>',
  powerlines: '<path d="M8 1.5 4.5 14.5M8 1.5l3.5 13M3.5 5h9M4.5 9h7"/>',
  crowd: '<circle cx="5.5" cy="5" r="1.8"/><circle cx="10.5" cy="5" r="1.8"/><path d="M2.5 13c0-2.5 1.5-4 3-4s3 1.5 3 4M7.5 13c0-2.5 1.5-4 3-4s3 1.5 3 4"/>',
  wind: '<path d="M2 6h8.5a2 2 0 1 0-2-2M2 10h11a2 2 0 1 1-2 2"/>',
  rain: '<path d="M4 9h8a2.5 2.5 0 0 0 0-5 3.5 3.5 0 0 0-6.5-.5A2.5 2.5 0 0 0 4 9z"/><path d="M5.5 11.5l-1 2.5M8.5 11.5l-1 2.5M11.5 11.5l-1 2.5"/>',
  visibility: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  clouds: '<path d="M4 12h8a3 3 0 0 0 0-6 4 4 0 0 0-7.6-.8A3.2 3.2 0 0 0 4 12z"/>',
  air: '<path d="M2 5c2-1.5 4 1.5 6 0s4 1.5 6 0M2 9c2-1.5 4 1.5 6 0s4 1.5 6 0M2 13c2-1.5 4 1.5 6 0s4 1.5 6 0"/>',
  zone: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.5"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 4.8v.2"/>',
}
export const icon = (type, cls = 'ic') =>
  `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICON[type] || ICON.info}</svg>`

// Title shown on each row, and what it means for someone who has never flown a drone.
export const INFO = {
  raptors: { title: 'Hawks and eagles nearby', why: 'Hawks and eagles defend their territory and sometimes attack drones in the air. A strike can damage the drone or injure the bird.' },
  nesting: { title: 'Bird nesting', why: 'During nesting season, a drone overhead can scare parent birds off their nests. Eggs and chicks left alone can get cold or be taken by predators.' },
  migration: { title: 'Seasonal migration', why: 'In spring and fall, large flocks pass through. More birds in the air means a higher chance of a collision.' },
  powerlines: { title: 'Power lines', why: 'Wires are hard to see against the sky and trees. Flying into one can bring the drone down and damage the line. Mapped lines come from OpenStreetMap; some lines may not be mapped, so look around before you take off.' },
  crowd: { title: 'People and buildings', why: 'Over busy areas, a drone that loses power or signal can fall on people or property.' },
  wind: { title: 'Wind', why: 'Gusts at drone height are usually stronger than at ground level. Strong gusts can push a small drone off course or drain its battery on the way back.' },
  rain: { title: 'Rain', why: 'Most small drones are not waterproof. Rain can damage the electronics and makes the propellers less effective.' },
  visibility: { title: 'Visibility', why: 'US drone rules (FAA Part 107) require at least 3 statute miles of visibility so you can keep the drone in sight.' },
  clouds: { title: 'Cloud height', why: 'US drone rules (FAA Part 107) require staying at least 500 feet below the clouds. Low clouds leave little room to fly.' },
  air: { title: 'Air quality', why: 'Smoke and haze reduce visibility, which makes the drone harder to keep in sight.' },
}
export const titleOf = (type) => (INFO[type] ? INFO[type].title : type)

export const SEVERITY = {
  red: { label: 'High', cls: 'sev-high' },
  yellow: { label: 'Moderate', cls: 'sev-mid' },
  green: { label: 'Low', cls: 'sev-low' },
  unknown: { label: 'No data', cls: 'sev-none' },
}

const RANK = { red: 0, yellow: 1, green: 2, unknown: 3 }
const ORDER = ['powerlines', 'raptors', 'wind', 'clouds', 'visibility', 'rain', 'nesting', 'crowd', 'migration', 'air']
export function sortHazards(list) {
  return (Array.isArray(list) ? list : [])
    .filter((h) => h && h.type)
    .map((h) => ({ ...h, level: RANK[h.level] === undefined ? 'unknown' : h.level }))
    .sort((a, b) => RANK[a.level] - RANK[b.level] || ORDER.indexOf(a.type) - ORDER.indexOf(b.type))
}

// How complete the assessment is: hazards with real data vs. sources that reported "unknown".
export function completeness(list) {
  const all = sortHazards(list)
  const missing = all.filter((h) => h.level === 'unknown')
  return { total: all.length, available: all.length - missing.length, missing }
}
