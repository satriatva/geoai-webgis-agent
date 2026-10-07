import { geocodePlace, reverseGeocode } from './geocode.js';
import { findNearbyPlaces, CATEGORIES } from './places.js';
import { measureDistance, createBuffer } from './geometry.js';

const latLon = {
  type: 'object',
  properties: {
    lat: { type: 'number', description: 'Latitude in decimal degrees (WGS84)' },
    lon: { type: 'number', description: 'Longitude in decimal degrees (WGS84)' },
    label: { type: 'string', description: 'Optional display name for the point' },
  },
  required: ['lat', 'lon'],
};

/**
 * Tool registry. Each entry pairs a provider-neutral declaration (name, description and
 * JSON Schema parameters, translated by every LLM adapter) with the function that runs it.
 *
 * Every tool returns { data, geojson }: `data` goes back to the model, `geojson` only to the
 * map. Keeping geometry out of the prompt keeps requests small.
 *
 * To add a tool: write the function in this folder, declare it here, and add a label for it
 * in public/js/app.js (TOOL_LABELS).
 */
export const tools = {
  geocode_place: {
    declaration: {
      name: 'geocode_place',
      description:
        'Find the coordinates of a named place, landmark or address. Use this before any spatial ' +
        'operation when the user names a location instead of giving coordinates.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Place name or address, e.g. "Monas, Jakarta"' },
          country_code: { type: 'string', description: 'Optional ISO 3166-1 alpha-2 code, e.g. "id"' },
        },
        required: ['query'],
      },
    },
    run: geocodePlace,
  },

  reverse_geocode: {
    declaration: {
      name: 'reverse_geocode',
      description: 'Describe what is at a coordinate: the nearest address and administrative areas.',
      parameters: latLon,
    },
    run: reverseGeocode,
  },

  find_nearby_places: {
    declaration: {
      name: 'find_nearby_places',
      description:
        'List points of interest of one category within a radius of a point, nearest first, ' +
        'from OpenStreetMap. Radius is capped at 5000 m.',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number', description: 'Latitude of the search centre' },
          lon: { type: 'number', description: 'Longitude of the search centre' },
          category: { type: 'string', enum: Object.keys(CATEGORIES), description: 'Place category' },
          radius_m: { type: 'number', description: 'Search radius in metres (50-5000), default 1000' },
          limit: { type: 'integer', description: 'Maximum results to return (1-25), default 10' },
        },
        required: ['lat', 'lon', 'category'],
      },
    },
    run: findNearbyPlaces,
  },

  measure_distance: {
    declaration: {
      name: 'measure_distance',
      description: 'Straight-line distance and compass bearing between two coordinates.',
      parameters: {
        type: 'object',
        properties: { origin: latLon, destination: latLon },
        required: ['origin', 'destination'],
      },
    },
    run: measureDistance,
  },

  create_buffer: {
    declaration: {
      name: 'create_buffer',
      description: 'Draw a circular buffer zone of a given radius around a point and return its area.',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number', description: 'Latitude of the centre' },
          lon: { type: 'number', description: 'Longitude of the centre' },
          radius_m: { type: 'number', description: 'Radius in metres (1-50000)' },
        },
        required: ['lat', 'lon', 'radius_m'],
      },
    },
    run: createBuffer,
  },
};
