import { config } from '../config.js';
import { fetchJson, createThrottle } from './http.js';
import { pointFeature, featureCollection, round } from './geometry.js';

// NOTE: the Nominatim usage policy allows at most one request per second; 1.1 s leaves a margin.
const NOMINATIM_INTERVAL_MS = 1100;
const nominatim = createThrottle(NOMINATIM_INTERVAL_MS);

/** Forward geocoding: place name or address -> candidate coordinates (OpenStreetMap Nominatim). */
export async function geocodePlace({ query, country_code }) {
  if (!query || typeof query !== 'string') throw new Error('query is required');
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', addressdetails: '0' });
  if (country_code) params.set('countrycodes', String(country_code).toLowerCase());

  const rows = await nominatim(() => fetchJson(`${config.nominatimUrl}/search?${params}`));
  const candidates = rows.map((r) => ({
    name: r.display_name,
    lat: round(Number(r.lat), 6),
    lon: round(Number(r.lon), 6),
    category: `${r.category}/${r.type}`,
    osm: r.osm_type && r.osm_id ? `${r.osm_type}/${r.osm_id}` : undefined,
  }));

  return {
    data: candidates.length ? { candidates } : { candidates: [], note: `No match for "${query}".` },
    geojson: featureCollection(
      candidates.slice(0, 1).map((c) => pointFeature(c.lon, c.lat, { title: c.name, category: c.category, osm: c.osm, kind: 'place' })),
    ),
  };
}

/** Reverse geocoding: coordinates -> nearest address (OpenStreetMap Nominatim). */
export async function reverseGeocode({ lat, lon }) {
  // zoom 18 asks Nominatim for building-level detail.
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon), format: 'jsonv2', zoom: '18' });
  const r = await nominatim(() => fetchJson(`${config.nominatimUrl}/reverse?${params}`));
  if (r.error) return { data: { address: null, note: r.error }, geojson: featureCollection([]) };

  const a = r.address || {};
  const data = {
    address: r.display_name,
    road: a.road,
    village: a.village || a.suburb || a.neighbourhood,
    district: a.city_district || a.county,
    city: a.city || a.town || a.regency || a.state_district,
    province: a.state,
    country: a.country,
  };
  return {
    data,
    geojson: featureCollection([pointFeature(lon, lat, {
      title: r.display_name,
      osm: r.osm_type && r.osm_id ? `${r.osm_type}/${r.osm_id}` : undefined,
      kind: 'place',
    })]),
  };
}
