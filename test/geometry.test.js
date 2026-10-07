import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureDistance, createBuffer } from '../src/tools/geometry.js';

const MONAS = { lat: -6.1754, lon: 106.8272 };
const BUNDARAN_HI = { lat: -6.195, lon: 106.823 };

test('measure_distance returns great-circle distance and bearing', () => {
  const { data, geojson } = measureDistance({ origin: MONAS, destination: BUNDARAN_HI });
  assert.ok(data.distance_km > 2.1 && data.distance_km < 2.4, `got ${data.distance_km} km`);
  assert.equal(data.direction, 'S');
  assert.equal(geojson.features[0].geometry.type, 'LineString');
});

test('measure_distance rejects invalid coordinates', () => {
  assert.throws(() => measureDistance({ origin: { lat: 95, lon: 0 }, destination: MONAS }), /latitude/);
});

test('create_buffer area matches pi * r^2 within 1%', () => {
  const { data, geojson } = createBuffer({ lat: -7.78, lon: 110.37, radius_m: 1000 });
  assert.ok(Math.abs(data.area_km2 - Math.PI) / Math.PI < 0.01, `got ${data.area_km2} km²`);
  assert.equal(geojson.features[0].geometry.type, 'Polygon');
});

test('create_buffer enforces radius limits', () => {
  assert.throws(() => createBuffer({ lat: 0, lon: 0, radius_m: 0 }), /radius_m/);
  assert.throws(() => createBuffer({ lat: 0, lon: 0, radius_m: 60000 }), /radius_m/);
});

test('measure_distance accepts the "from1_" name Gemini produces for a reserved word', () => {
  const { data } = measureDistance({ from1_: MONAS, to: BUNDARAN_HI });
  assert.ok(data.distance_km > 2.1);
  assert.throws(() => measureDistance({ destination: MONAS }), /origin is required/);
});
