import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverpassQuery, findNearbyPlaces } from '../src/tools/places.js';

test('buildOverpassQuery targets the mapped OSM tag within the radius', () => {
  const q = buildOverpassQuery({ lat: -7.77, lon: 110.38, category: 'hospital', radius_m: 2000 });
  assert.match(q, /node\["amenity"="hospital"\]\(around:2000,-7.77,110.38\)/);
  assert.match(q, /way\["amenity"="hospital"\]/);
  assert.match(q, /out center/);
});

test('findNearbyPlaces sorts by distance, caps the radius and returns map layers', async () => {
  const elements = [
    { type: 'node', id: 1, lat: -7.78, lon: 110.38, tags: { name: 'Far Hospital' } },
    { type: 'way', id: 2, center: { lat: -7.7705, lon: 110.3805 }, tags: { name: 'Near Hospital' } },
    { type: 'node', id: 3, lat: -7.775, lon: 110.381, tags: {} },
  ];
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.match(decodeURIComponent(init.body), /around:5000/); // 9000 requested, capped to 5000
    return new Response(JSON.stringify({ elements }), { status: 200 });
  });

  const { data, geojson } = await findNearbyPlaces({ lat: -7.77, lon: 110.38, category: 'hospital', radius_m: 9000 });
  fetchMock.mock.restore();

  assert.equal(data.radius_m, 5000);
  assert.deepEqual(data.results.map((r) => r.name), ['Near Hospital', 'Unnamed hospital', 'Far Hospital']);
  assert.ok(data.results[0].distance_m < data.results[1].distance_m);
  assert.equal(geojson.features[0].geometry.type, 'Polygon'); // search buffer
});

test('findNearbyPlaces rejects unknown categories', async () => {
  await assert.rejects(findNearbyPlaces({ lat: 0, lon: 0, category: 'castle' }), /unsupported category/);
});
