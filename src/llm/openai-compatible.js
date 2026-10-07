/**
 * Any OpenAI-compatible Chat Completions API: OpenAI, Ollama, Groq, OpenRouter,
 * LM Studio, vLLM... Uses plain fetch, so no extra SDK is needed.
 */

const MODEL_LIST_TIMEOUT_MS = 8000;

/** Neutral history -> OpenAI `messages`. */
export function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        }));
      }
      out.push(msg);
    } else {
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.response) });
      }
    }
  }
  return out;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw; // some servers already return an object
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { _unparsed: String(raw) };
  }
}

/** Reasoning models (Qwen 3, DeepSeek R1) may wrap their thinking in <think> tags. */
export const stripThinking = (text) => String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

/**
 * Create a provider for an OpenAI-compatible server.
 *
 * @param {object}   options
 * @param {string}   options.name          Id used by the API and the UI, e.g. "groq".
 * @param {string}   options.label         Display name.
 * @param {string}   options.baseUrl       API root that ends before /chat/completions.
 * @param {string}  [options.apiKey]       Sent as a Bearer token when present.
 * @param {string}   options.model         Default model id.
 * @param {boolean} [options.requiresKey]  False for local servers such as Ollama.
 * @param {string[]}[options.models]       Fallback model list when /models is unavailable.
 * @param {Function}[options.filterModels] Keeps only chat models from the /models response.
 */
export function createOpenAICompatibleProvider({
  name,
  label,
  baseUrl,
  apiKey,
  model,
  headers = {},
  timeoutMs = 120000,
  requiresKey = true,
  models = [],
  filterModels = () => true,
  local = false,
}) {
  const root = baseUrl.replace(/\/+$/, '');
  const url = `${root}/chat/completions`;
  const authHeaders = { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...headers };

  return {
    name,
    label,
    model,
    local,
    configured: Boolean(model) && Boolean(root) && (!requiresKey || Boolean(apiKey)),

    /** Models from the provider's /models endpoint, filtered to chat models; preset list as fallback. */
    async listModels() {
      try {
        const res = await fetch(`${root}/models`, { headers: authHeaders, signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const ids = (data.data ?? []).filter(filterModels).map((m) => m.id).sort();
        if (ids.length) return { models: ids, source: 'live' };
        throw new Error('empty model list');
      } catch (err) {
        return { models: models.length ? models : [model].filter(Boolean), source: 'preset', note: err.message };
      }
    },

    async chat({ system, messages, tools, allowTools = true, temperature = 0.3, model: override }) {
      const body = {
        model: override || model,
        temperature,
        messages: toOpenAIMessages(system, messages),
      };
      // With tools disabled, omit them entirely: some servers (e.g. Groq) return 400 when
      // tool_choice is "none" but the model still emits a tool call.
      if (allowTools) {
        body.tools = tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        body.tool_choice = 'auto';
      }

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const unreachable = new Error(`Cannot reach ${label} at ${baseUrl} (${err.cause?.code ?? err.name}).`);
        unreachable.code = err.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE';
        throw unreachable;
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data?.error?.message ?? `${label} responded ${res.status}`);
        err.status = res.status;
        throw err;
      }

      const msg = data.choices?.[0]?.message ?? {};
      return {
        text: stripThinking(msg.content),
        toolCalls: (msg.tool_calls ?? []).map((c, i) => ({
          id: c.id || `call_${i}`,
          name: c.function?.name,
          args: parseArgs(c.function?.arguments),
        })),
      };
    },
  };
}
