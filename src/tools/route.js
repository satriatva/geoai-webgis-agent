import * as turf from '@turf/turf';
import { config } from '../config.js';
import { createThrottle, fetchJson } from './http.js';
import { assertLatLon, featureCollection, pointFeature, round } from './geometry.js';
import { CATEGORIES, elementToPlace, runOverpass } from './places.js';

// Limits keep corridor queries small, because the public OSRM and Overpass servers are shared.
const MAX_ROUTE_KM = 50;
const DEFAULT_CORRIDOR_M = 300;
const MIN_CORRIDOR_M = 50;
const MAX_CORRIDOR_M = 1000;
const DEFAULT_LIMIT = 15;
const MAX_RESULTS = 25;
const MAX_CATEGORIES = 3;
const MAX_QUERY_VERTICES = 150;
const OSRM_TIMEOUT_MS = 20000;
// NOTE: a corridor query scans a whole route, so it gets more time than a radius search on the busy public server.
const CORRIDOR_TIMEOUT_MS = 55000;
const CORRIDOR_SERVER_TIMEOUT_S = 50;

// NOTE: the OSRM demo server allows at most one request per second.
const OSRM_INTERVAL_MS = 1100;
const osrm = createThrottle(OSRM_INTERVAL_MS);

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/** Fastest road route by car between two points (OSRM), as an OSRM route object with GeoJSON geometry. */
export async function fetchRoute(origin, destination) {
  const coords = `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;
  const url = `${config.osrmUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  let json;
  try {
    json = await osrm(() => fetchJson(url, { timeoutMs: OSRM_TIMEOUT_MS }));
  } catch (err) {
    // OSRM answers 400 when it cannot snap a point to the road network or finds no route.
    if (/responded 400/.test(err.message)) throw new Error('no road route between these points; check that both are reachable by car');
    throw err;
  }
  if (json.code !== 'Ok' || !json.routes?.length) throw new Error(`no road route between these points (OSRM: ${json.code})`);
  return json.routes[0];
}

/** Simplify the route until it has few enough vertices for an Overpass `around` filter. */
export function simplifyForQuery(line) {
  let tolerance = 0.0001; // degrees, about 11 m
  let simple = line;
  while (simple.geometry.coordinates.length > MAX_QUERY_VERTICES) {
    simple = turf.simplify(line, { tolerance, highQuality: false });
    tolerance *= 2;
  }
  return simple;
}

/**
 * Overpass QL for nodes and ways of the given categories within `corridor_m` of a polyline ([lon, lat] pairs).
 * The bounding box ([west, south, east, north]) narrows the candidates before the costly `around` filter.
 */
export function buildCorridorQuery({ path, bbox, categories, corridor_m }) {
  const [w, s, e, n] = bbox.map((v) => round(v, 5));
  const candidates = categories.map((category) => {
    const [k, v] = CATEGORIES[category];
    return `nw["${k}"="${v}"](${s},${w},${n},${e});`;
  });
  const points = path.map(([lon, lat]) => `${round(lat, 5)},${round(lon, 5)}`).join(',');
  const around = `(around:${Math.round(corridor_m)},${points})`;
  // NOTE: the candidates need a named set; inside a union, `node._` would overwrite `_` before `way._` reads it.
  return `[out:json][timeout:${CORRIDOR_SERVER_TIMEOUT_S}];(${candidates.join('')})->.c;(node.c${around};way.c${around};);out center 300;`;
}

async function queryCorridor(query) {
  try {
    return await runOverpass(query, { timeoutMs: CORRIDOR_TIMEOUT_MS });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('the Overpass server did not answer in time (it is shared and often busy); retry, or ask about a shorter route or fewer categories');
    throw err;
  }
}

const categoryOf = (el, categories) => categories.find((c) => el.tags?.[CATEGORIES[c][0]] === CATEGORIES[c][1]);

/**
 * Up to `max` places, shared out evenly between the categories so one common category (cafes)
 * cannot crowd out another (fuel). Within a category the places closest to the road go first.
 */
export function pickClosest(places, categories, max) {
  const queues = categories.map((c) => places.filter((p) => p.category === c).sort((a, b) => a.off_route_m - b.off_route_m));
  const picked = [];
  while (picked.length < max && queues.some((q) => q.length)) {
    for (const q of queues) if (q.length && picked.length < max) picked.push(q.shift());
  }
  return picked;
}

/**
 * Places of up to three categories along the road route from origin to destination, in travel order.
 * `along_km` is the distance from the start along the route, `off_route_m` the distance from the road.
 */
export async function findPlacesAlongRoute({ origin, destination, categories, corridor_m = DEFAULT_CORRIDOR_M, limit = DEFAULT_LIMIT }) {
  if (!origin) throw new Error('origin is required: { lat, lon }');
  if (!destination) throw new Error('destination is required: { lat, lon }');
  assertLatLon(origin.lat, origin.lon);
  assertLatLon(destination.lat, destination.lon);
  const wanted = [...new Set([categories ?? []].flat())];
  if (!wanted.length) throw new Error('categories is required, e.g. ["cafe", "fuel"]');
  if (wanted.length > MAX_CATEGORIES) throw new Error(`at most ${MAX_CATEGORIES} categories per call`);
  const unknown = wanted.find((c) => !CATEGORIES[c]);
  if (unknown) throw new Error(`unsupported category "${unknown}"`);
  const corridor = clamp(Number(corridor_m) || DEFAULT_CORRIDOR_M, MIN_CORRIDOR_M, MAX_CORRIDOR_M);
  const max = clamp(Number(limit) || DEFAULT_LIMIT, 1, MAX_RESULTS);

  const route = await fetchRoute(origin, destination);
  const routeKm = route.distance / 1000;
  if (routeKm > MAX_ROUTE_KM) {
    throw new Error(`the road route is ${round(routeKm, 1)} km; along-route search supports routes up to ${MAX_ROUTE_KM} km`);
  }
  const line = turf.lineString(route.geometry.coordinates);
  const path = simplifyForQuery(line);
  const corridorArea = turf.buffer(path, corridor / 1000, { units: 'kilometers' });
  corridorArea.properties = { title: `${corridor} m corridor`, kind: 'buffer' };

  const elements = await queryCorridor(
    buildCorridorQuery({ path: path.geometry.coordinates, bbox: turf.bbox(corridorArea), categories: wanted, corridor_m: corridor }),
  );
  const seen = new Set();
  const places = elements
    .map((el) => {
      const category = categoryOf(el, wanted);
      const place = category && elementToPlace(el, category);
      if (!place || seen.has(place.osm)) return null;
      seen.add(place.osm);
      const snap = turf.nearestPointOnLine(line, [place.lon, place.lat], { units: 'kilometers' }).properties;
      return { ...place, category, along_km: round(snap.lineDistance, 2), off_route_m: Math.round(snap.pointDistance * 1000) };
    })
    .filter(Boolean);

  const top = pickClosest(places, wanted, max).sort((a, b) => a.along_km - b.along_km);

  return {
    data: {
      route: { distance_km: round(routeKm, 2), duration_min: Math.round(route.duration / 60), mode: 'car' },
      corridor_m: corridor,
      categories: wanted,
      total_found: places.length,
      found_per_category: Object.fromEntries(wanted.map((c) => [c, places.filter((p) => p.category === c).length])),
      results: top,
      note: 'Road distance by car from OSRM. along_km is measured from the start along the route; off_route_m is the distance from the road.',
      source: 'Route: OSRM. Places: OpenStreetMap contributors via Overpass API',
    },
    geojson: featureCollection([
      corridorArea,
      turf.lineString(route.geometry.coordinates, { title: `${round(routeKm, 1)} km by road`, kind: 'route' }),
      // Route ends are marked but kept out of the result list: geocode_place already lists the same places.
      pointFeature(origin.lon, origin.lat, { title: `Start: ${origin.label || 'origin'}`, kind: 'route-end' }),
      pointFeature(destination.lon, destination.lat, { title: `End: ${destination.label || 'destination'}`, kind: 'route-end' }),
      ...top.map((p) =>
        pointFeature(p.lon, p.lat, {
          title: p.name,
          description: `${p.along_km} km along the route, ${p.off_route_m} m off it`,
          category: p.category,
          along_km: p.along_km,
          off_route_m: p.off_route_m,
          osm: p.osm,
          kind: 'poi',
        }),
      ),
    ]),
  };
}
