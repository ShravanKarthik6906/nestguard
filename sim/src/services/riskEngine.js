
const clamp = value => Math.max(0, Math.min(100, value))

export function assessRisk({
  weather,
  infrastructure,
  wildlife,
  airspace,
  battery = 100
}) {
  const factors = []

  function add(name, score, weight, source, detail) {
    factors.push({
      name,
      score: score == null ? null : Math.round(clamp(score)),
      weight,
      source,
      detail
    })
  }

  add(
    'Wind',
    weather ? weather.wind / 15 * 100 : null,
    1.5,
    'Open-Meteo',
    weather ? `${weather.wind} m/s` : 'Unavailable'
  )

  add(
    'Gusts',
    weather ? weather.gust / 20 * 100 : null,
    1.4,
    'Open-Meteo',
    weather ? `${weather.gust} m/s` : 'Unavailable'
  )

  add(
    'Precipitation',
    weather ? weather.precipitation / 4 * 100 : null,
    1.3,
    'Open-Meteo',
    weather ? `${weather.precipitation} mm` : 'Unavailable'
  )

  add(
    'Visibility',
    weather?.visibility != null
      ? (3000 - weather.visibility) / 3000 * 100
      : null,
    1,
    'Open-Meteo',
    weather?.visibility != null
      ? `${Math.round(weather.visibility)} m`
      : 'Unavailable'
  )

  add(
    'Mapped power lines',
    infrastructure
      ? infrastructure.nearest == null
        ? 0
        : (250 - infrastructure.nearest) / 250 * 100
      : null,
    1.7,
    'OpenStreetMap',
    infrastructure
      ? infrastructure.nearest == null
        ? 'No mapped lines returned'
        : `${Math.round(infrastructure.nearest)} m`
      : 'Unavailable'
  )

  add(
    'Battery',
    100 - battery,
    1,
    'Simulation',
    `${battery}% initial charge`
  )

  // Historical observations are context, not a calibrated
  // measure of present-day bird collision risk.
  add(
    'Wildlife',
    null,
    0,
    'iNaturalist',
    wildlife
      ? `${wildlife.speciesCount} historically observed species`
      : 'Unavailable'
  )

  const available = factors.filter(f => f.score !== null)
  const denominator = available.reduce(
    (sum, factor) => sum + factor.weight,
    0
  )

  const score = denominator
    ? Math.round(
        available.reduce(
          (sum, factor) => sum + factor.score * factor.weight,
          0
        ) / denominator
      )
    : null

  const level = score == null
    ? 'UNKNOWN'
    : score >= 60
      ? 'HIGH'
      : score >= 30
        ? 'MEDIUM'
        : 'LOW'

  const warnings = []

  if (!weather) warnings.push('Weather data unavailable')
  if (!infrastructure) {
    warnings.push('Power-line mapping unavailable')
  }
  if (!wildlife) warnings.push('Wildlife data unavailable')
  if (airspace?.status !== 'verified') {
    warnings.push('Airspace and authorization unverified')
  }

  if (infrastructure?.nearest != null &&
      infrastructure.nearest < 50) {
    warnings.push('Mapped electrical infrastructure nearby')
  }

  if (weather?.wind >= 10) {
    warnings.push('Elevated wind speed')
  }

  if (weather?.gust >= 15) {
    warnings.push('Elevated wind gusts')
  }

  return {
    score,
    level,
    factors,
    warnings,
    coverage: {
      available: available.length,
      total: factors.filter(f => f.weight > 0).length
    },
    flightAuthorized: false,
    disclaimer:
      'Experimental heuristic. Not a validated aviation safety assessment or flight authorization.'
  }
}
