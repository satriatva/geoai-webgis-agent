/**
 * Client for the GeoAI WebGIS Agent API.
 */

// Local models on CPU can need several minutes for a multi-step answer.
const CHAT_TIMEOUT_MS = 5 * 60 * 1000;
const STREAM_TYPE = 'application/x-ndjson';

/**
 * Ask the agent and report progress while it works.
 *
 * @param {object}   body             { conversation, mapContext, provider?, model? }
 * @param {object}   options
 * @param {Function} options.onEvent  Receives { type: 'thinking' | 'tool' | 'step', ... } events.
 * @param {AbortSignal} [options.signal] Cancels the request (Stop button).
 * @returns {Promise<object>} The final result: { reply, steps, layers, provider, providerLabel, model }.
 */
export async function askAgent(body, { onEvent = () => {}, signal } = {}) {
  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: STREAM_TYPE },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  // Validation errors (400, 503) are returned before streaming starts, as plain JSON.
  if (!res.headers.get('content-type')?.includes(STREAM_TYPE)) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The server responded ${res.status}.`);
    return data;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += value;
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'result') return event;
      if (event.type === 'error') throw new Error(event.error);
      onEvent(event);
    }
    if (done) throw new Error('The connection closed before the agent finished.');
  }
}

/** List providers known to the server: { default, providers: [{ name, label, configured, ... }] }. */
export async function getProviders() {
  const res = await fetch('/api/providers');
  if (!res.ok) throw new Error(`The server responded ${res.status}.`);
  return res.json();
}

/** Models offered by one provider: { models, source: 'live' | 'preset', note? }. */
export async function getModels(name) {
  const res = await fetch(`/api/providers/${encodeURIComponent(name)}/models`);
  if (!res.ok) throw new Error(`The server responded ${res.status}.`);
  return res.json();
}
