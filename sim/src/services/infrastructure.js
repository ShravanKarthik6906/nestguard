
const EARTH_RADIUS = 6371000;

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (degrees) => degrees * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
}

function distanceToSegment(lat, lon, a, b) {
  const latScale = 111320;
  const lonScale = 111320 * Math.cos(lat * Math.PI / 180);

  const ax = (a[0] - lon) * lonScale;
  const ay = (a[1] - lat) * latScale;
  const bx = (b[0] - lon) * lonScale;
  const by = (b[1] - lat) * latScale;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(ax, ay);
  }

  const t = Math.max(
    0,
    Math.min(1, -(ax * dx + ay * dy) / lengthSquared)
  );

  return Math.hypot(ax + t * dx, ay + t * dy);
}

export async function getInfrastructure(lat, lon, signal) {
  const response = await fetch(
    `/api/infrastructure?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
    { signal }
  );

  const raw = await response.text();

  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(
      "Infrastructure backend returned invalid JSON. Check the Express server."
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error || `Infrastructure request failed: HTTP ${response.status}`
    );
  }

  const features = [];
  let nearest = Infinity;

  for (const element of data.elements || []) {
    if (!Array.isArray(element.geometry)) continue;

    const coordinates = element.geometry
      .filter(
        (point) =>
          Number.isFinite(point.lat) &&
          Number.isFinite(point.lon)
      )
      .map((point) => [point.lon, point.lat]);

    if (coordinates.length < 2) continue;

    for (let i = 0; i < coordinates.length - 1; i++) {
      nearest = Math.min(
        nearest,
        distanceToSegment(
          lat,
          lon,
          coordinates[i],
          coordinates[i + 1]
        )
      );
    }

    features.push({
      type: "Feature",
      properties: {
        id: element.id,
        power: element.tags?.power || "line",
        voltage: element.tags?.voltage || null,
      },
      geometry: {
        type: "LineString",
        coordinates,
      },
    });
  }

  return {
    count: features.length,
    nearest: Number.isFinite(nearest) ? nearest : null,
    radius: 750,
    geojson: {
      type: "FeatureCollection",
      features,
    },
    source: "OpenStreetMap / Overpass",
    status: "ready",
  };
}
