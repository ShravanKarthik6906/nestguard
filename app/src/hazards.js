// Hazard rows under the verdict. Small custom line glyphs (not a stock icon set), drawn with currentColor.
const G = {
  nesting: '<path d="M2.5 9.5c1.5 3 9.5 3 11 0"/><path d="M3 9.5h10"/><ellipse cx="8" cy="7" rx="2" ry="2.4"/>',
  raptors: '<path d="M1.5 7.5c2.5-2.5 4.5-2 6.5 1 2-3 4-3.5 6.5-1"/><path d="M8 8.5v3"/>',
  powerlines: '<path d="M8 1.5 4.5 14.5M8 1.5l3.5 13M3.5 5h9M4.5 9h7"/>',
  crowd: '<circle cx="5.5" cy="5" r="1.8"/><circle cx="10.5" cy="5" r="1.8"/><path d="M2.5 13c0-2.5 1.5-4 3-4s3 1.5 3 4M7.5 13c0-2.5 1.5-4 3-4s3 1.5 3 4"/>',
  migration: '<path d="M2 6l2 1.5L6 6M7 10l2 1.5 2-1.5M10 4l2 1.5L14 4"/>',
  air: '<path d="M2 5c2-1.5 4 1.5 6 0s4 1.5 6 0M2 9c2-1.5 4 1.5 6 0s4 1.5 6 0M2 13c2-1.5 4 1.5 6 0s4 1.5 6 0"/>',
  wind: '<path d="M2 6h8.5a2 2 0 1 0-2-2M2 10h11a2 2 0 1 1-2 2"/>',
  rain: '<path d="M4 9h8a2.5 2.5 0 0 0 0-5 3.5 3.5 0 0 0-6.5-.5A2.5 2.5 0 0 0 4 9z"/><path d="M5.5 11.5l-1 2.5M8.5 11.5l-1 2.5M11.5 11.5l-1 2.5"/>',
  visibility: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  clouds: '<path d="M4 12h8a3 3 0 0 0 0-6 4 4 0 0 0-7.6-.8A3.2 3.2 0 0 0 4 12z"/>',
}
export const NAMES = {
  nesting: 'Nesting', raptors: 'Raptors', powerlines: 'Power lines', crowd: 'People below', migration: 'Migration',
  air: 'Air quality', wind: 'Wind', rain: 'Rain', visibility: 'Visibility', clouds: 'Cloud base',
}
const RANK = { red: 0, yellow: 1, green: 2 }
// When two hazards have the same color, the more immediate danger to the drone comes first.
const ORDER = ['powerlines', 'raptors', 'wind', 'clouds', 'visibility', 'rain', 'nesting', 'crowd', 'migration', 'air']

// Worst first; "unknown" (a data source is down) is left out.
export function sortHazards(list) {
  return (Array.isArray(list) ? list : [])
    .filter((h) => h && RANK[h.level] !== undefined)
    .sort((a, b) => RANK[a.level] - RANK[b.level] || ORDER.indexOf(a.type) - ORDER.indexOf(b.type))
}

export function hazardRow(h) {
  const li = document.createElement('li')
  li.className = 'hazard'
  li.innerHTML = `<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true">${G[h.type] || '<circle cx="8" cy="8" r="5"/>'}</svg>
    <span class="name"></span><span class="detail"></span><i class="dot ${h.level}" title="${h.level}"></i>`
  li.querySelector('.name').textContent = NAMES[h.type] || h.type
  li.querySelector('.detail').textContent = h.detail || ''
  return li
}
