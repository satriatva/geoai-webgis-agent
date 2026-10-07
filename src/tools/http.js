import { config } from '../config.js';

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

/**
 * Fetch JSON with a timeout, an identifying User-Agent and a small in-memory cache.
 * Public OSM services are shared infrastructure, so repeated identical queries are
 * answered from cache instead of hitting the server again.
 */
export async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 20000 } = {}) {
  const key = `${method} ${url} ${body ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const res = await fetch(url, {
    method,
    body,
    headers: { 'User-Agent': config.userAgent, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  const data = await res.json();

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** Serialise calls so a service sees at most one request per `intervalMs` (Nominatim: 1 req/s). */
export function createThrottle(intervalMs) {
  let last = 0;
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(async () => {
      const wait = last + intervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
}
