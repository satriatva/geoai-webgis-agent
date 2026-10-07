import 'dotenv/config';

export const APP_NAME = 'GeoAI WebGIS Agent';
export const REPO_URL = 'https://github.com/satriatva/geoai-webgis-agent';

/** Positive number from an environment variable, or the fallback. */
const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Runtime settings read from .env (see .env.example for every variable). */
export const config = {
  port: positive(process.env.PORT, 3000),
  maxAgentSteps: positive(process.env.MAX_AGENT_STEPS, 6),
  nominatimUrl: process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
  overpassUrl: process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
  // NOTE: the Nominatim usage policy asks for an identifying User-Agent with contact details.
  // Set CONTACT_EMAIL in .env when you deploy the app.
  userAgent: `geoai-webgis-agent/1.0 (${process.env.CONTACT_EMAIL || REPO_URL})`,
};
