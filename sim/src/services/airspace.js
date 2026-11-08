
export async function getAirspace(lat, lon) {
  return {
    latitude: lat,
    longitude: lon,
    status: 'unverified',
    authorization: null,
    controlledAirspace: null,
    restrictions: [],
    source: 'Not connected',
    message:
      'FAA airspace and flight restrictions have not been verified. This prototype cannot authorize a real-world drone flight.',
    officialResource:
      'https://www.faa.gov/uas/getting_started/where_can_i_fly'
  }
}
