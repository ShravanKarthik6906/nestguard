
export async function getWeather(lat, lon, signal) {
  const url = new URL('https://api.open-meteo.com/v1/forecast')

  url.searchParams.set('latitude', lat)
  url.searchParams.set('longitude', lon)
  url.searchParams.set(
    'current',
    'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code'
  )
  url.searchParams.set('hourly', 'visibility')
  url.searchParams.set('forecast_days', '1')
  url.searchParams.set('wind_speed_unit', 'ms')
  url.searchParams.set('timezone', 'auto')

  const response = await fetch(url, { signal })

  if (!response.ok) {
    throw new Error(`Weather API: HTTP ${response.status}`)
  }

  const data = await response.json()
  const current = data.current

  if (!current) throw new Error('Weather data unavailable')

  const hour = current.time?.slice(0, 13)
  const index = data.hourly?.time?.findIndex(
    value => value.startsWith(hour)
  ) ?? -1

  return {
    wind: current.wind_speed_10m,
    gust: current.wind_gusts_10m,
    windDirection: current.wind_direction_10m,
    temperature: current.temperature_2m,
    humidity: current.relative_humidity_2m,
    precipitation: current.precipitation,
    weatherCode: current.weather_code,
    visibility: index >= 0
      ? data.hourly.visibility[index]
      : null,
    timestamp: current.time,
    source: 'Open-Meteo',
    status: 'ready'
  }
}
