import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiProvider, toGeminiSchema, toGeminiContents } from '../src/llm/gemini.js';
import { createOpenAICompatibleProvider, toOpenAIMessages, stripThinking } from '../src/llm/openai-compatible.js';
import { createProvider } from '../src/llm/index.js';

const tools = [{
  name: 'geocode_place',
  description: 'Find coordinates',
  parameters: { type: 'object', properties: { query: { type: 'string' }, at: { type: 'object', properties: { lat: { type: 'number' } } } }, required: ['query'] },
}];

const history = [
  { role: 'user', text: 'Where is Monas?' },
  { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'geocode_place', args: { query: 'Monas' } }] },
  { role: 'tool', results: [{ id: 'c1', name: 'geocode_place', response: { result: { lat: -6.17 } } }] },
];

// ---------- Gemini ----------
test('toGeminiSchema uppercases types recursively', () => {
  const s = toGeminiSchema(tools[0].parameters);
  assert.equal(s.type, 'OBJECT');
  assert.equal(s.properties.query.type, 'STRING');
  assert.equal(s.properties.at.properties.lat.type, 'NUMBER');
  assert.deepEqual(s.required, ['query']);
});

test('toGeminiContents maps tool calls and results to Gemini parts', () => {
  const c = toGeminiContents(history);
  assert.deepEqual(c.map((x) => x.role), ['user', 'model', 'user']);
  assert.equal(c[1].parts[0].functionCall.name, 'geocode_place');
  assert.deepEqual(c[2].parts[0].functionResponse.response, { result: { lat: -6.17 } });
});

test('Gemini provider normalises function calls from the SDK response', async () => {
  let sent;
  const client = {
    models: {
      generateContent: async (req) => {
        sent = req;
        return { functionCalls: [{ name: 'geocode_place', args: { query: 'Monas' } }], text: '', candidates: [{ content: { role: 'model', parts: [] } }] };
      },
    },
  };
  const llm = createGeminiProvider({ model: 'gemini-test', client });
  const out = await llm.chat({ system: 'sys', messages: history.slice(0, 1), tools, allowTools: false });
  assert.equal(out.toolCalls[0].name, 'geocode_place');
  assert.deepEqual(out.native, { role: 'model', parts: [] });
  assert.equal(sent.config.systemInstruction, 'sys');
  assert.equal(sent.config.tools[0].functionDeclarations[0].parameters.type, 'OBJECT');
  assert.equal(sent.config.toolConfig.functionCallingConfig.mode, 'NONE');
});

// ---------- OpenAI-compatible ----------
test('toOpenAIMessages builds system, assistant tool_calls and tool messages', () => {
  const m = toOpenAIMessages('sys', history);
  assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(m[2].tool_calls[0].function.arguments, '{"query":"Monas"}');
  assert.equal(m[3].tool_call_id, 'c1');
  assert.equal(JSON.parse(m[3].content).result.lat, -6.17);
});

test('stripThinking removes <think> blocks from reasoning models', () => {
  assert.equal(stripThinking('<think>plan steps</think>\nMonas is 2.2 km away.'), 'Monas is 2.2 km away.');
});

test('OpenAI-compatible provider sends tools and parses tool calls', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(init.headers.Authorization, undefined); // Ollama needs no key
    assert.equal(body.model, 'qwen3:8b');
    assert.equal(body.tools[0].function.name, 'geocode_place');
    assert.equal(body.tool_choice, 'auto');
    return new Response(JSON.stringify({
      choices: [{ message: { content: '<think>x</think>', tool_calls: [{ id: 'a1', type: 'function', function: { name: 'geocode_place', arguments: '{"query":"Monas"}' } }] } }],
    }));
  });
  const llm = createOpenAICompatibleProvider({ name: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1/', model: 'qwen3:8b', requiresKey: false });
  const out = await llm.chat({ system: 'sys', messages: history.slice(0, 1), tools });
  fetchMock.mock.restore();

  assert.equal(llm.configured, true);
  assert.equal(out.text, '');
  assert.deepEqual(out.toolCalls, [{ id: 'a1', name: 'geocode_place', args: { query: 'Monas' } }]);
});

test('OpenAI-compatible provider surfaces HTTP status for retry and error messages', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429 }));
  const llm = createOpenAICompatibleProvider({ name: 'groq', label: 'Groq', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' });
  await assert.rejects(llm.chat({ system: '', messages: [], tools }), (err) => err.status === 429 && /Rate limit/.test(err.message));
  fetchMock.mock.restore();
});

test('OpenAI-compatible provider reports an unreachable server', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  });
  const llm = createOpenAICompatibleProvider({ name: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', requiresKey: false });
  await assert.rejects(llm.chat({ system: '', messages: [], tools }), (err) => err.code === 'UNREACHABLE' && /ECONNREFUSED/.test(err.message));
  fetchMock.mock.restore();
});

// ---------- Provider selection ----------
test('createProvider picks presets, keys and model overrides from env', () => {
  assert.equal(createProvider({}).name, 'gemini');
  assert.equal(createProvider({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-2.5-flash-lite' }).model, 'gemini-2.5-flash-lite');

  const ollama = createProvider({ LLM_PROVIDER: 'ollama' });
  assert.equal(ollama.model, 'qwen3:8b');
  assert.equal(ollama.configured, true);

  const groq = createProvider({ LLM_PROVIDER: 'groq', LLM_MODEL: 'qwen/qwen3-32b' });
  assert.equal(groq.model, 'qwen/qwen3-32b');
  assert.equal(groq.configured, false); // no GROQ_API_KEY
  assert.equal(createProvider({ LLM_PROVIDER: 'groq', GROQ_API_KEY: 'k' }).configured, true);

  assert.equal(createProvider({ LLM_PROVIDER: 'custom', LLM_BASE_URL: 'http://localhost:1234/v1', LLM_MODEL: 'local' }).configured, true);
  assert.throws(() => createProvider({ LLM_PROVIDER: 'nope' }), /Unknown LLM_PROVIDER/);
});

// ---------- Model lists and multi-provider setup ----------
test('listModels returns the filtered live list, or the preset list when offline', async () => {
  const llm = createOpenAICompatibleProvider({
    name: 'groq', label: 'Groq', baseUrl: 'https://x/v1', apiKey: 'k', model: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'qwen/qwen3-32b'], filterModels: (m) => !/whisper/.test(m.id),
  });
  let fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://x/v1/models');
    assert.equal(init.headers.Authorization, 'Bearer k');
    return new Response(JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'qwen/qwen3-32b' }, { id: 'llama-3.1-8b-instant' }] }));
  });
  assert.deepEqual(await llm.listModels(), { models: ['llama-3.1-8b-instant', 'qwen/qwen3-32b'], source: 'live' });
  fetchMock.mock.restore();

  fetchMock = mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  const offline = await llm.listModels();
  fetchMock.mock.restore();
  assert.equal(offline.source, 'preset');
  assert.deepEqual(offline.models, ['llama-3.3-70b-versatile', 'qwen/qwen3-32b']);
});

test('chat uses a per-request model override', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (_u, init) => {
    assert.equal(JSON.parse(init.body).model, 'qwen3:4b');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  const llm = createOpenAICompatibleProvider({ name: 'ollama', label: 'Ollama', baseUrl: 'http://h/v1', model: 'qwen3:8b', requiresKey: false });
  const out = await llm.chat({ system: '', messages: [], tools, model: 'qwen3:4b' });
  fetchMock.mock.restore();
  assert.equal(out.text, 'ok');
});

test('Gemini listModels keeps chat models only, with a preset fallback', async () => {
  const client = {
    models: {
      list: async () => [
        { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] },
        { name: 'models/gemini-embedding-001', supportedActions: ['embedContent'] },
        { name: 'models/gemini-2.5-flash-preview-tts', supportedActions: ['generateContent'] },
        { name: 'models/gemini-2.5-pro', supportedActions: ['generateContent'] },
      ],
    },
  };
  const llm = createGeminiProvider({ model: 'gemini-2.5-flash', client });
  assert.deepEqual(await llm.listModels(), { models: ['gemini-2.5-flash', 'gemini-2.5-pro'], source: 'live' });

  const broken = createGeminiProvider({ model: 'gemini-2.5-flash', client: { models: { list: async () => { throw new Error('403'); } } }, models: ['a', 'b'] });
  assert.deepEqual((await broken.listModels()).models, ['a', 'b']);
});

test('createProviders exposes every preset and marks which are configured', async () => {
  const { createProviders } = await import('../src/llm/index.js');
  const { providers, defaultName } = createProviders({ LLM_PROVIDER: 'groq', GROQ_API_KEY: 'k', LLM_MODEL: 'qwen/qwen3-32b' });
  assert.equal(defaultName, 'groq');
  assert.equal(providers.groq.model, 'qwen/qwen3-32b'); // LLM_MODEL applies to the default provider
  assert.equal(providers.gemini.configured, false);       // no GEMINI_API_KEY
  assert.equal(providers.ollama.configured, true);        // local, no key needed
  assert.equal(providers.custom, undefined);              // only with LLM_BASE_URL
  assert.ok(createProviders({ LLM_BASE_URL: 'http://localhost:1234/v1', LLM_MODEL: 'm' }).providers.custom.configured);
});

test('OpenAI-compatible provider omits tools entirely when tool use is disabled', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (_u, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'final' } }] }));
  });
  const llm = createOpenAICompatibleProvider({ name: 'groq', label: 'Groq', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' });
  const out = await llm.chat({ system: '', messages: history, tools, allowTools: false });
  fetchMock.mock.restore();
  assert.equal(out.text, 'final');
});
