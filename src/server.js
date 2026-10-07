import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createProviders } from './llm/index.js';
import { config, APP_NAME } from './config.js';
import { runAgent } from './agent.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Request limits. They keep prompts small and protect the free tiers of the providers.
const MAX_TURNS = 30;
const MAX_TEXT_LENGTH = 4000;
const MAX_BODY_SIZE = '200kb';
const MODEL_ID = /^[\w.:/@-]{1,120}$/;
const MODEL_LIST_CACHE_MS = 10 * 60 * 1000;

/** Content type a client sends in `Accept` to receive progress events while the agent works. */
export const STREAM_CONTENT_TYPE = 'application/x-ndjson';

/** Return an error message for an invalid conversation, or null when it is valid. */
function validateConversation(conversation) {
  if (!Array.isArray(conversation) || conversation.length === 0) return 'conversation must be a non-empty array';
  if (conversation.length > MAX_TURNS) return `conversation is limited to ${MAX_TURNS} turns`;
  for (const m of conversation) {
    if (!['user', 'model'].includes(m?.role)) return 'role must be "user" or "model"';
    if (typeof m.text !== 'string' || !m.text.trim()) return 'every turn needs non-empty text';
    if (m.text.length > MAX_TEXT_LENGTH) return `each turn is limited to ${MAX_TEXT_LENGTH} characters`;
  }
  if (conversation.at(-1).role !== 'user') return 'the last turn must come from the user';
  return null;
}

/** Keep only finite coordinates from the client's map state, rounded to 6 decimals (~0.1 m). */
function sanitizeMapContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return undefined;
  const point = (p) =>
    p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? { lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) } : undefined;
  return {
    center: point(ctx.center),
    zoom: Number.isFinite(ctx.zoom) ? ctx.zoom : undefined,
    selectedPoint: point(ctx.selectedPoint),
  };
}

/** Turn a provider error into an HTTP status and a message the user can act on. */
export function describeModelError(err, llm = {}) {
  const who = llm.label ?? 'The model provider';
  const status = Number(err?.status);
  if (err?.code === 'UNREACHABLE') {
    return { http: 503, error: `${err.message} Is the server running? For Ollama, start it and pull the model (ollama pull ${llm.model ?? '<model>'}).` };
  }
  if (err?.code === 'TIMEOUT') {
    return { http: 504, error: `${who} took too long to answer. Local models can be slow on CPU; try a smaller model or raise LLM_TIMEOUT_MS.` };
  }
  if (status === 429) {
    return { http: 429, error: `${who} rate limit or quota reached (429). Wait a minute and retry, or pick another model or provider.` };
  }
  if (status >= 500) {
    return { http: 503, error: `${who} is temporarily unavailable (${status}). Please try again in a moment.` };
  }
  if (status >= 400) {
    return { http: 502, error: `${who} rejected the request (${status}): ${err.message}. Check the API key, the model name and whether the model supports tool calling.` };
  }
  return { http: 500, error: `Agent error: ${err?.message ?? 'unknown error'}` };
}

/**
 * Build the Express app.
 *
 * @param {object}  options
 * @param {object} [options.providers]   Map of provider name -> provider (see src/llm).
 * @param {string} [options.defaultName] Provider used when a request does not pick one.
 * @param {object} [options.llm]         Shorthand for a one-provider app (used by the tests).
 * @param {number} [options.maxSteps]    Agent step budget per question.
 */
export function createApp({ llm, providers, defaultName, maxSteps = config.maxAgentSteps } = {}) {
  if (!providers) {
    providers = llm ? { [llm.name]: llm } : {};
    defaultName = llm?.name;
  }
  const modelCache = new Map(); // provider name -> { at, value }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: MAX_BODY_SIZE }));
  app.use(express.static(path.join(ROOT, 'public')));
  // Leaflet and the fonts are served from node_modules, so the page needs no CDN.
  app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules', 'leaflet', 'dist')));
  app.use('/vendor/fonts', express.static(path.join(ROOT, 'node_modules', '@fontsource'), { maxAge: '30d' }));

  const summary = (p) => ({ name: p.name, label: p.label, defaultModel: p.model, configured: Boolean(p.configured), local: Boolean(p.local) });

  app.get('/api/health', (_req, res) => {
    const d = providers[defaultName];
    res.json({ ok: true, app: APP_NAME, provider: d?.name, providerLabel: d?.label, model: d?.model, configured: Boolean(d?.configured) });
  });

  // Every provider the server knows, configured or not, so the UI can explain what is missing.
  app.get('/api/providers', (_req, res) => {
    res.json({ default: defaultName, providers: Object.values(providers).map(summary) });
  });

  app.get('/api/providers/:name/models', async (req, res) => {
    const p = providers[req.params.name];
    if (!p) return res.status(404).json({ error: 'unknown provider' });
    if (!p.configured) return res.json({ models: [p.model].filter(Boolean), source: 'preset', note: 'not configured' });

    const hit = modelCache.get(p.name);
    if (hit && Date.now() - hit.at < MODEL_LIST_CACHE_MS) return res.json(hit.value);

    const value = p.listModels ? await p.listModels() : { models: [p.model], source: 'preset' };
    if (!value.models.includes(p.model)) value.models.unshift(p.model);
    if (value.source === 'live') modelCache.set(p.name, { at: Date.now(), value });
    res.json(value);
  });

  /**
   * Ask the agent. Body: { conversation, mapContext?, provider?, model? }.
   * With `Accept: application/x-ndjson` the response is a stream of JSON lines:
   * progress events while the agent works, then { type: 'result', ... } or { type: 'error', ... }.
   * Without it, the response is a single JSON object (simpler for scripts and tests).
   */
  app.post('/api/chat', async (req, res) => {
    const name = req.body?.provider || defaultName;
    const provider = providers[name];
    if (!provider) return res.status(400).json({ error: `Unknown provider "${name}".` });
    if (!provider.configured) {
      return res.status(503).json({ error: `${provider.label} is not configured. Add its API key to .env and restart the server.` });
    }
    const model = req.body?.model || provider.model;
    if (!MODEL_ID.test(model)) return res.status(400).json({ error: 'Invalid model name.' });

    const problem = validateConversation(req.body?.conversation);
    if (problem) return res.status(400).json({ error: problem });

    // Bind the chosen model, so the agent loop stays provider- and model-agnostic.
    const llmForRequest = { ...provider, model, chat: (request) => provider.chat({ ...request, model }) };
    const meta = { provider: provider.name, providerLabel: provider.label, model };

    const streaming = req.accepts(['application/json', STREAM_CONTENT_TYPE]) === STREAM_CONTENT_TYPE;
    const send = (event) => res.write(`${JSON.stringify(event)}\n`);
    if (streaming) {
      res.status(200).set({ 'Content-Type': STREAM_CONTENT_TYPE, 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
    }

    try {
      const result = await runAgent({
        llm: llmForRequest,
        maxSteps,
        conversation: req.body.conversation,
        mapContext: sanitizeMapContext(req.body.mapContext),
        onEvent: streaming ? send : undefined,
      });
      if (streaming) {
        send({ type: 'result', ...result, ...meta });
        res.end();
      } else {
        res.json({ ...result, ...meta });
      }
    } catch (err) {
      console.error('[agent]', provider.name, model, err?.status ?? '', err?.message ?? err);
      const { http, error } = describeModelError(err, llmForRequest);
      if (streaming) {
        send({ type: 'error', status: http, error });
        res.end();
      } else {
        res.status(http).json({ error });
      }
    }
  });

  return app;
}

// Start the server when this file is run directly (not when the tests import it).
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  let built;
  try {
    built = createProviders();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  const { providers, defaultName } = built;
  const ready = Object.values(providers).filter((p) => p.configured).map((p) => p.label);
  createApp({ providers, defaultName }).listen(config.port, () => {
    const d = providers[defaultName];
    console.log(`${APP_NAME} running at http://localhost:${config.port}`);
    console.log(`Default model: ${d.label} (${d.model})${d.configured ? '' : ' - NOT CONFIGURED'}`);
    console.log(`Available in the UI: ${ready.join(', ') || 'none (add an API key to .env)'}`);
  });
}
