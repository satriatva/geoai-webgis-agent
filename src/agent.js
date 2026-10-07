import { tools as defaultTools } from './tools/index.js';

/** Default number of model turns that may request tools before a final answer is forced. */
export const DEFAULT_MAX_STEPS = 6;

const SYSTEM_PROMPT = `You are GeoAI WebGIS Agent, a geospatial assistant attached to a web map.
- Use the tools for every location fact: coordinates, addresses, nearby places, distances and buffers. Never invent coordinates or place names.
- When the user names a place, call geocode_place first, then use the returned coordinates in later tools. If several candidates match, pick the most plausible one and say which.
- "Here", "this point" or "the selected point" means the user-selected point in the map context below.
- Chain tools when a question needs several steps (for example geocode, then find_nearby_places).
- If a tool returns an error, fix the arguments and try once more; never repeat an identical call.
- As soon as you have the information needed, stop calling tools and answer.
- Report distances in metres below 1 km and in kilometres above. Say that distances are straight-line.
- Credit OpenStreetMap contributors when you list places.
- Reply in the same language as the user, concisely, using short lists for multiple results.`;

function describeMapContext(ctx) {
  if (!ctx) return '';
  const lines = ['Map context:'];
  if (ctx.center) lines.push(`- Current map centre: lat ${ctx.center.lat}, lon ${ctx.center.lon} (zoom ${ctx.zoom ?? '?'})`);
  if (ctx.selectedPoint) lines.push(`- User-selected point: lat ${ctx.selectedPoint.lat}, lon ${ctx.selectedPoint.lon}`);
  return lines.length > 1 ? `\n\n${lines.join('\n')}` : '';
}

// ---------------------------------------------------------------------------
// Retry policy for model calls
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DEFAULTS = { retries: 2, baseDelayMs: 2000, maxWaitMs: 20000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read a server-suggested wait from an error message, e.g. Gemini's `"retryDelay": "23s"`. */
function retryDelayMs(err) {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(err?.message ?? '');
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

/**
 * Call the model and retry transient failures (rate limit, overload) with exponential backoff.
 * NOTE: waits longer than `maxWaitMs` are not worth holding the HTTP request open for,
 * so they fail fast and the user sees the provider's message instead.
 */
export async function chatWithRetry(llm, request, options = {}) {
  const { retries, baseDelayMs, maxWaitMs } = { ...RETRY_DEFAULTS, ...options };
  for (let attempt = 0; ; attempt++) {
    try {
      return await llm.chat(request);
    } catch (err) {
      if (!RETRYABLE_STATUS.has(err?.status) || attempt >= retries) throw err;
      const wait = retryDelayMs(err) ?? baseDelayMs * 2 ** attempt;
      if (wait > maxWaitMs) throw err;
      await sleep(wait);
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback replies, so the user never gets an empty answer
// ---------------------------------------------------------------------------

function fallbackReply(steps) {
  const failed = steps.filter((s) => !s.ok);
  if (failed.length) {
    const reasons = [...new Set(failed.map((s) => `${s.tool}: ${s.error}`))].join('; ');
    return `I could not complete this request because a tool kept failing (${reasons}). Please rephrase the question or try again.`;
  }
  return 'I could not produce an answer for this request. Please try again or rephrase the question.';
}

function stepLimitReply(steps) {
  const done = [...new Set(steps.filter((s) => s.ok && !s.duplicate).map((s) => s.tool))];
  return (
    `I reached the limit of ${steps.length} tool calls before finishing an answer` +
    (done.length ? ` (completed: ${done.join(', ')}; any results are on the map).` : '.') +
    ' Please try again, ask a narrower question, or choose a different model.'
  );
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

/**
 * Run the provider-agnostic tool-calling loop:
 *   model -> tool calls -> run tools -> tool results -> model -> ... -> final answer
 *
 * History uses a neutral format ({ role: 'user' | 'assistant' | 'tool', ... }) that each
 * adapter in src/llm translates, so the loop works with any provider.
 *
 * @param {object}   options
 * @param {object}   options.llm           Provider from src/llm (must expose `chat`).
 * @param {Array}    options.conversation  Turns as { role: 'user' | 'model', text }.
 * @param {object}  [options.mapContext]   Map centre, zoom and the user-selected point.
 * @param {object}  [options.toolset]      Tool registry; defaults to src/tools.
 * @param {number}  [options.maxSteps]     Model turns allowed to request tools.
 * @param {object}  [options.retry]        Overrides for the retry policy (used by tests).
 * @param {Function}[options.onEvent]      Progress callback for streaming clients:
 *   { type: 'thinking' } before each model call, { type: 'tool', tool, args } before a tool
 *   runs and { type: 'step', step } after it finishes.
 * @returns {Promise<{ reply: string, steps: object[], layers: object[], truncated?: boolean }>}
 */
export async function runAgent({
  llm,
  conversation,
  mapContext,
  toolset = defaultTools,
  maxSteps = DEFAULT_MAX_STEPS,
  retry,
  onEvent = () => {},
}) {
  const messages = conversation.map(({ role, text }) =>
    role === 'user' ? { role: 'user', text } : { role: 'assistant', text },
  );
  const steps = [];
  const layers = [];
  const seen = new Map(); // tool call signature -> response
  const request = {
    system: SYSTEM_PROMPT + describeMapContext(mapContext),
    messages,
    tools: Object.values(toolset).map((t) => t.declaration),
  };

  const record = (step) => {
    steps.push(step);
    onEvent({ type: 'step', step });
  };

  for (let i = 0; i < maxSteps; i++) {
    onEvent({ type: 'thinking' });
    const turn = await chatWithRetry(llm, request, retry);

    if (!turn.toolCalls?.length) {
      return { reply: turn.text || fallbackReply(steps), steps, layers };
    }

    messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls, native: turn.native });

    const results = [];
    for (const call of turn.toolCalls) {
      const key = `${call.name}:${JSON.stringify(call.args ?? {})}`;

      // NOTE: some models repeat an identical call instead of answering. Reuse the earlier
      // result and tell the model to move on, rather than hitting OpenStreetMap again.
      if (seen.has(key)) {
        const response = { ...seen.get(key), note: 'Duplicate call: this exact call was already made. Use the result above and answer the user now.' };
        record({ tool: call.name, args: call.args, ok: true, duplicate: true, ms: 0 });
        results.push({ id: call.id, name: call.name, response });
        continue;
      }

      onEvent({ type: 'tool', tool: call.name, args: call.args });
      const started = Date.now();
      let response;
      try {
        const tool = toolset[call.name];
        if (!tool) throw new Error(`unknown tool "${call.name}"`);
        const { data, geojson } = await tool.run(call.args ?? {});
        response = { result: data };
        if (geojson?.features?.length) layers.push({ tool: call.name, geojson });
        record({ tool: call.name, args: call.args, ok: true, ms: Date.now() - started });
      } catch (err) {
        // A failing tool is reported to the model, which can fix its arguments or explain.
        response = { error: err.message };
        record({ tool: call.name, args: call.args, ok: false, error: err.message, ms: Date.now() - started });
      }
      seen.set(key, response);
      results.push({ id: call.id, name: call.name, response });
    }
    messages.push({ role: 'tool', results });
  }

  // NOTE: the step budget is used up, so ask for a final answer with tools disabled. Some
  // providers reject this when the model still tries to call a tool; fall back to a summary.
  let finalText = '';
  try {
    onEvent({ type: 'thinking' });
    const final = await chatWithRetry(llm, { ...request, allowTools: false }, retry);
    finalText = final.text;
  } catch (err) {
    console.warn('[agent] final answer failed:', err?.message ?? err);
  }
  return { reply: finalText || stepLimitReply(steps), steps, layers, truncated: true };
}
