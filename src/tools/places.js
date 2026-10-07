import { config } from '../config.js';
import { fetchJson } from './http.js';
import { assertLatLon, createBuffer, distanceMeters, featureCollection, pointFeature } from './geometry.js';

// Search limits. The public Overpass server is shared, so queries stay small.
const DEFAULT_RADIUS_M = 1000;
const MIN_RADIUS_M = 50;
const MAX_RADIUS_M = 5000;
const DEFAULT_LIMIT = 10;
const MAX_RESULTS = 25;
const OVERPASS_TIMEOUT_MS = 30000;

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/** Supported categories mapped to OpenStreetMap tags (key, value). */
export const CATEGORIES = {
  hospital: ['amenity', 'hospital'],
  clinic: ['amenity', 'clinic'],
  pharmacy: ['amenity', 'pharmacy'],
  school: ['amenity', 'school'],
  university: ['amenity', 'university'],
  restaurant: ['amenity', 'restaurant'],
  cafe: ['amenity', 'cafe'],
  fuel: ['amenity', 'fuel'],
  bank: ['amenity', 'bank'],
  atm: ['amenity', 'atm'],
  police: ['amenity', 'police'],
  fire_station: ['amenity', 'fire_station'],
  place_of_worship: ['amenity', 'place_of_worship'],
  supermarket: ['shop', 'supermarket'],
  hotel: ['tourism', 'hotel'],
  park: ['leisure', 'park'],
  bus_stop: ['highway', 'bus_stop'],
};

/** Build an Overpass QL query for nodes and ways with a tag inside a radius. `out center` gives ways a point. */
export function buildOverpassQuery({ lat, lon, category, radius_m }) {
  const [k, v] = CATEGORIES[category];
  const around = `(around:${Math.round(radius_m)},${lat},${lon})`;
  return `[out:json][timeout:25];(node["${k}"="${v}"]${around};way["${k}"="${v}"]${around};);out center 100;`;
}

/** Points of interest of one category within a radius, nearest first (OpenStreetMap Overpass). */
export async function findNearbyPlaces({ lat, lon, category, radius_m = 1000, limit = 10 }) {
  assertLatLon(lat, lon);
  if (!CATEGORIES[category]) throw new Error(`unsupported category "${category}"`);
  const radius = clamp(Number(radius_m) || DEFAULT_RADIUS_M, MIN_RADIUS_M, MAX_RADIUS_M);
  const max = clamp(Number(limit) || DEFAULT_LIMIT, 1, MAX_RESULTS);

  const query = buildOverpassQuery({ lat, lon, category, radius_m: radius });
  const json = await fetchJson(config.overpassUrl, {
    method: 'POST',
    body: new URLSearchParams({ data: query }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeoutMs: OVERPASS_TIMEOUT_MS,
  });

  const places = (json.elements || [])
    .map((el) => {
      const pLat = el.lat ?? el.center?.lat;
      const pLon = el.lon ?? el.center?.lon;
      if (pLat == null || pLon == null) return null;
      return {
        name: el.tags?.name || `Unnamed ${category.replace(/_/g, ' ')}`,
        lat: pLat,
        lon: pLon,
        distance_m: distanceMeters(lat, lon, pLat, pLon),
        osm: `${el.type}/${el.id}`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance_m - b.distance_m);

  const top = places.slice(0, max);
  const buffer = createBuffer({ lat, lon, radius_m: radius }).geojson.features[0];

  return {
    data: {
      category,
      radius_m: radius,
      total_found: places.length,
      results: top,
      source: 'OpenStreetMap contributors via Overpass API',
    },
    geojson: featureCollection([
      buffer,
      pointFeature(lon, lat, { title: 'Search centre', kind: 'center' }),
      ...top.map((p) =>
        pointFeature(p.lon, p.lat, {
          title: p.name,
          description: `${p.distance_m} m from the search centre`,
          distance_m: p.distance_m,
          category,
          osm: p.osm,
          kind: 'poi',
        }),
      ),
    ]),
  };
}
