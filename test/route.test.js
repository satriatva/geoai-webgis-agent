import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
import { buildCorridorQuery, findPlacesAlongRoute, pickClosest, simplifyForQuery } from '../src/tools/route.js';

// A 2.2 km route due south. Each test uses its own longitude because fetchJson caches responses.
const routeAt = (lon) => ({
  code: 'Ok',
  routes: [{ distance: 2224, duration: 300, geometry: { type: 'LineString', coordinates: [[lon, -6.2], [lon, -6.21], [lon, -6.22]] } }],
});

/** Mock fetch: OSRM answers with `route` (or `osrm`), Overpass with `elements`; returns the request log. */
function mockServices({ route, osrm, elements = [] }) {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? decodeURIComponent(init.body) : '' });
    if (String(url).includes('/route/v1/')) return osrm ?? new Response(JSON.stringify(route), { status: 200 });
    return new Response(JSON.stringify({ elements }), { status: 200 });
  });
  return { calls, restore: () => fetchMock.mock.restore() };
}

const origin = (lon) => ({ lat: -6.2, lon, label: 'Start point' });
const destination = (lon) => ({ lat: -6.22, lon, label: 'End point' });

test('buildCorridorQuery takes candidates from the bounding box, then filters them along the polyline', () => {
  const q = buildCorridorQuery({
    path: [[106.8, -6.2], [106.81, -6.21]], bbox: [106.79, -6.22, 106.82, -6.19], categories: ['cafe', 'fuel'], corridor_m: 300,
  });
  assert.match(q, /nw\["amenity"="cafe"\]\(-6.22,106.79,-6.19,106.82\);nw\["amenity"="fuel"\]/);
  assert.match(q, /\)->\.c;\(node\.c\(around:300,-6.2,106.8,-6.21,106.81\);way\.c\(around:300,/);
  assert.equal(q.match(/around:/g).length, 2); // the polyline is sent once per element type, not per category
  assert.match(q, /out center/);
});

test('simplifyForQuery keeps long routes under the vertex limit', () => {
  const coords = Array.from({ length: 2000 }, (_, i) => [106.8 + i * 0.0001, -6.2 + Math.sin(i / 20) * 0.001]);
  const simple = simplifyForQuery(turf.lineString(coords));
  assert.ok(simple.geometry.coordinates.length <= 150);
});

test('findPlacesAlongRoute lists places in travel order and keeps geometry out of the data', async () => {
  const lon = 106.8;
  const elements = [
    { type: 'node', id: 1, lat: -6.218, lon: 106.801, tags: { amenity: 'cafe', name: 'Late Cafe' } },
    { type: 'way', id: 2, center: { lat: -6.202, lon: 106.8005 }, tags: { amenity: 'fuel', name: 'Early Fuel' } },
    { type: 'node', id: 3, lat: -6.21, lon: 106.8002, tags: { amenity: 'cafe' } },
  ];
  const svc = mockServices({ route: routeAt(lon), elements });
  const { data, geojson } = await findPlacesAlongRoute({
    origin: origin(lon), destination: destination(lon), categories: ['cafe', 'fuel'], corridor_m: 5000,
  });
  svc.restore();

  assert.match(svc.calls[0].url, /\/route\/v1\/driving\/106.8,-6.2;106.8,-6.22\?overview=full&geometries=geojson/);
  assert.match(svc.calls[1].body, /around:1000,/); // 5000 requested, capped to 1000
  assert.deepEqual(data.results.map((r) => r.name), ['Early Fuel', 'Unnamed cafe', 'Late Cafe']);
  assert.deepEqual(data.results.map((r) => r.category), ['fuel', 'cafe', 'cafe']);
  assert.ok(data.results[0].along_km < data.results[1].along_km);
  assert.ok(data.results[0].off_route_m > 0);
  assert.equal(data.route.distance_km, 2.22);
  assert.equal(data.route.duration_min, 5);
  assert.doesNotMatch(JSON.stringify(data), /coordinates/);
  assert.deepEqual(geojson.features.slice(0, 2).map((f) => f.properties.kind), ['buffer', 'route']);
  assert.equal(geojson.features.filter((f) => f.properties.kind === 'poi').length, 3);
  assert.deepEqual(geojson.features.filter((f) => f.properties.kind === 'route-end').map((f) => f.properties.title), ['Start: Start point', 'End: End point']);
});

test('findPlacesAlongRoute caps the results to the places closest to the road', async () => {
  const lon = 106.7;
  const elements = Array.from({ length: 30 }, (_, i) => ({
    type: 'node', id: i, lat: -6.2 - i * 0.0006, lon: lon + (i % 2 ? 0.002 : 0.0001), tags: { amenity: 'atm' },
  }));
  const svc = mockServices({ route: routeAt(lon), elements });
  const { data } = await findPlacesAlongRoute({ origin: origin(lon), destination: destination(lon), categories: 'atm', limit: 100 });
  svc.restore();

  assert.equal(data.total_found, 30);
  assert.equal(data.results.length, 25);
  assert.ok(data.results.every((r, i, all) => i === 0 || all[i - 1].along_km <= r.along_km));
});

test('findPlacesAlongRoute explains when OSRM finds no route', async () => {
  const svc = mockServices({ osrm: new Response(JSON.stringify({ code: 'NoRoute' }), { status: 400 }) });
  await assert.rejects(
    findPlacesAlongRoute({ origin: origin(106.6), destination: destination(106.6), categories: ['cafe'] }),
    /no road route between these points/,
  );
  svc.restore();
});

test('findPlacesAlongRoute refuses routes longer than the limit before querying Overpass', async () => {
  const lon = 106.5;
  const route = routeAt(lon);
  route.routes[0].distance = 80000;
  const svc = mockServices({ route });
  await assert.rejects(
    findPlacesAlongRoute({ origin: origin(lon), destination: destination(lon), categories: ['cafe'] }),
    /80 km; along-route search supports routes up to 50 km/,
  );
  svc.restore();
  assert.equal(svc.calls.length, 1);
});

test('findPlacesAlongRoute validates categories', async () => {
  const args = { origin: origin(106.4), destination: destination(106.4) };
  await assert.rejects(findPlacesAlongRoute({ ...args, categories: [] }), /categories is required/);
  await assert.rejects(findPlacesAlongRoute({ ...args, categories: ['cafe', 'fuel', 'atm', 'bank'] }), /at most 3 categories/);
  await assert.rejects(findPlacesAlongRoute({ ...args, categories: ['castle'] }), /unsupported category "castle"/);
});

test('findPlacesAlongRoute turns an Overpass timeout into a message the model can explain', async () => {
  const lon = 106.3;
  const fetchMock = mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/route/v1/')) return new Response(JSON.stringify(routeAt(lon)), { status: 200 });
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  await assert.rejects(
    findPlacesAlongRoute({ origin: origin(lon), destination: destination(lon), categories: ['cafe'] }),
    /Overpass server did not answer in time/,
  );
  fetchMock.mock.restore();
});

test('pickClosest shares the limit between categories so a common one cannot crowd out the rest', () => {
  const cafes = Array.from({ length: 10 }, (_, i) => ({ name: `cafe ${i}`, category: 'cafe', off_route_m: i }));
  const fuel = [{ name: 'far fuel', category: 'fuel', off_route_m: 250 }, { name: 'near fuel', category: 'fuel', off_route_m: 40 }];
  const picked = pickClosest([...cafes, ...fuel], ['cafe', 'fuel'], 5);
  assert.equal(picked.length, 5);
  assert.deepEqual(picked.filter((p) => p.category === 'fuel').map((p) => p.name), ['near fuel', 'far fuel']);
  assert.deepEqual(picked.filter((p) => p.category === 'cafe').map((p) => p.name), ['cafe 0', 'cafe 1', 'cafe 2']);
});
