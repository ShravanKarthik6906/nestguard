
export async function getWildlife(lat, lon, signal) {
  const url = new URL(
    'https://api.inaturalist.org/v1/observations/species_counts'
  )

  url.searchParams.set('lat', lat)
  url.searchParams.set('lng', lon)
  url.searchParams.set('radius', '5')
  url.searchParams.set('taxon_id', '3')
  url.searchParams.set('quality_grade', 'research')
  url.searchParams.set('per_page', '30')
  url.searchParams.set('order', 'desc')

  const response = await fetch(url, { signal })

  if (!response.ok) {
    throw new Error(`Wildlife API: HTTP ${response.status}`)
  }

  const data = await response.json()

  const species = (data.results || []).map(item => ({
    id: item.taxon?.id,
    name: item.taxon?.preferred_common_name ||
      item.taxon?.name ||
      'Unknown species',
    scientificName: item.taxon?.name || '',
    observations: item.count || 0,
    image: item.taxon?.default_photo?.medium_url || null
  }))

  return {
    species,
    speciesCount: data.total_results ?? species.length,
    observationCount: species.reduce(
      (sum, item) => sum + item.observations,
      0
    ),
    radiusKm: 5,
    source: 'iNaturalist',
    status: 'ready',
    disclaimer:
      'Historical citizen-science observations; not live bird locations or a measured collision probability.'
  }
}
