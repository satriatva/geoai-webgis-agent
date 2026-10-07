import * as turf from '@turf/turf';

export const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export const pointFeature = (lon, lat, properties = {}) => turf.point([lon, lat], properties);
export const featureCollection = (features) => turf.featureCollection(features);

export function assertLatLon(lat, lon) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`invalid latitude: ${lat}`);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error(`invalid longitude: ${lon}`);
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Great-circle distance and initial bearing between two points.
 * Parameters are named origin/destination: Gemini rewrites reserved words such as
 * "from" (it arrives as "from1_"), so those names are accepted only as fallbacks.
 */
export function measureDistance(args = {}) {
  const from = args.origin ?? args.from ?? args.from1_ ?? args.from_;
  const to = args.destination ?? args.to;
  if (!from) throw new Error('origin is required: { lat, lon }');
  if (!to) throw new Error('destination is required: { lat, lon }');
  assertLatLon(from.lat, from.lon);
  assertLatLon(to.lat, to.lon);
  const a = turf.point([from.lon, from.lat]);
  const b = turf.point([to.lon, to.lat]);
  const km = turf.distance(a, b, { units: 'kilometers' });
  const bearing = (turf.bearing(a, b) + 360) % 360;

  return {
    data: {
      distance_km: round(km, 3),
      distance_m: Math.round(km * 1000),
      bearing_deg: round(bearing, 1),
      direction: COMPASS[Math.round(bearing / 45) % 8],
      note: 'Straight-line (great-circle) distance, not road distance.',
    },
    geojson: featureCollection([
      turf.lineString([[from.lon, from.lat], [to.lon, to.lat]], { title: `${round(km, 2)} km`, kind: 'line' }),
      pointFeature(from.lon, from.lat, { title: from.label || 'Start', kind: 'place' }),
      pointFeature(to.lon, to.lat, { title: to.label || 'End', kind: 'place' }),
    ]),
  };
}

/** Circular buffer around a point, returned as a polygon with its area. */
export function createBuffer({ lat, lon, radius_m }) {
  assertLatLon(lat, lon);
  const r = Number(radius_m);
  if (!Number.isFinite(r) || r <= 0 || r > 50000) throw new Error('radius_m must be between 1 and 50000');

  const circle = turf.circle([lon, lat], r / 1000, {
    steps: 64,
    units: 'kilometers',
    properties: { title: `${r} m buffer`, kind: 'buffer' },
  });
  const areaKm2 = turf.area(circle) / 1e6;
  return {
    data: { center: { lat, lon }, radius_m: r, area_km2: round(areaKm2, 3) },
    geojson: featureCollection([circle]),
  };
}

/** Distance in metres from a centre to each feature, for ranking search results. */
export function distanceMeters(lat, lon, lat2, lon2) {
  return Math.round(turf.distance([lon, lat], [lon2, lat2], { units: 'meters' }));
}
