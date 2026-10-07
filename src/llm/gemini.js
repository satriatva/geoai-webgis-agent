import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';

/** JSON Schema (lowercase types) -> Gemini Schema (uppercase type enum). */
export function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') out.type = value.toUpperCase();
    else if (key === 'properties') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else if (key === 'items') out.items = toGeminiSchema(value);
    else out[key] = value;
  }
  return out;
}

/** Neutral history -> Gemini `contents`. */
export function toGeminiContents(messages) {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', parts: [{ text: m.text }] };
    if (m.role === 'assistant') {
      // Reuse Gemini's own content when we have it, so thought signatures survive.
      if (m.native) return m.native;
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { id: c.id, name: c.name, args: c.args } });
      return { role: 'model', parts };
    }
    // role === 'tool'
    return {
      role: 'user',
      parts: m.results.map((r) => ({ functionResponse: { id: r.id, name: r.name, response: r.response } })),
    };
  });
}

/** Gemini model ids that are not text chat models, hidden from the model picker. */
const NON_CHAT = /embedding|imagen|image|tts|audio|live|veo|aqa|robotics|computer-use/i;

/**
 * Google Gemini through the official Gen AI SDK (@google/genai).
 * `client` can be injected by tests; otherwise it is created from the API key.
 */
export function createGeminiProvider({ apiKey, model, client, models = [] }) {
  const ai = client ?? (apiKey ? new GoogleGenAI({ apiKey }) : null);
  return {
    name: 'gemini',
    label: 'Google Gemini',
    model,
    local: false,
    configured: Boolean(ai),

    /** Gemini models that support generateContent, from the API; preset list as fallback. */
    async listModels() {
      try {
        const ids = [];
        const pager = await ai.models.list({ config: { pageSize: 100 } });
        for await (const m of pager) {
          const id = String(m.name ?? '').replace(/^models\//, '');
          const actions = m.supportedActions ?? [];
          if (id.startsWith('gemini') && actions.includes('generateContent') && !NON_CHAT.test(id)) ids.push(id);
        }
        if (ids.length) return { models: ids.sort(), source: 'live' };
        throw new Error('empty model list');
      } catch (err) {
        return { models: models.length ? models : [model], source: 'preset', note: err.message };
      }
    },

    async chat({ system, messages, tools, allowTools = true, temperature = 0.3, model: override }) {
      const response = await ai.models.generateContent({
        model: override || model,
        contents: toGeminiContents(messages),
        config: {
          systemInstruction: system,
          temperature,
          tools: [{
            functionDeclarations: tools.map((t) => ({ ...t, parameters: toGeminiSchema(t.parameters) })),
          }],
          ...(allowTools ? {} : { toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } } }),
        },
      });
      const calls = response.functionCalls ?? [];
      return {
        text: (response.text ?? '').trim(),
        toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} })), // ids may be absent
        // NOTE: the raw content is sent back unchanged next turn, so Gemini's thought signatures survive.
        native: response.candidates?.[0]?.content,
      };
    },
  };
}
