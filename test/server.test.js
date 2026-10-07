import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, describeModelError } from '../src/server.js';

let server;
let base;

const llm = {
  name: 'fake',
  label: 'Fake LLM',
  model: 'fake-1',
  configured: true,
  chat: async () => ({ text: 'Hello from the agent.', toolCalls: [] }),
};

before(async () => {
  server = createApp({ llm }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (body) =>
  fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('GET /api/health reports the provider and model', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.deepEqual(await res.json(), { ok: true, app: 'GeoAI WebGIS Agent', provider: 'fake', providerLabel: 'Fake LLM', model: 'fake-1', configured: true });
});

test('POST /api/chat returns the agent reply', async () => {
  const res = await post({ conversation: [{ role: 'user', text: 'hi' }] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.reply, 'Hello from the agent.');
  assert.deepEqual(data.steps, []);
});

test('POST /api/chat validates the conversation', async () => {
  for (const body of [{}, { conversation: [] }, { conversation: [{ role: 'system', text: 'x' }] }, { conversation: [{ role: 'model', text: 'x' }] }]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('serves the web client', async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /GeoAI WebGIS Agent/);
});

test('describeModelError gives actionable messages per failure type', () => {
  const p = { label: 'Ollama', model: 'qwen3:8b' };
  assert.equal(describeModelError({ status: 429 }, p).http, 429);
  assert.match(describeModelError({ status: 429 }, p).error, /quota/);
  assert.equal(describeModelError({ status: 503 }, p).http, 503);
  assert.match(describeModelError({ status: 401, message: 'bad key' }, p).error, /API key/);
  assert.match(describeModelError({ code: 'UNREACHABLE', message: 'Cannot reach Ollama.' }, p).error, /ollama pull qwen3:8b/);
  assert.match(describeModelError({ code: 'TIMEOUT' }, p).error, /LLM_TIMEOUT_MS/);
  assert.match(describeModelError(new Error('boom')).error, /boom/);
});

test('multi-provider app: lists providers and models, and honours the chosen provider and model', async () => {
  const seen = [];
  const make = (name, configured) => ({
    name, label: name.toUpperCase(), model: `${name}-default`, configured, local: name === 'ollama',
    listModels: async () => ({ models: [`${name}-a`, `${name}-b`], source: 'live' }),
    chat: async (req) => { seen.push([name, req.model]); return { text: `answered by ${name}`, toolCalls: [] }; },
  });
  const app = createApp({ providers: { groq: make('groq', true), ollama: make('ollama', true), openai: make('openai', false) }, defaultName: 'groq' });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const list = await (await fetch(`${url}/api/providers`)).json();
    assert.equal(list.default, 'groq');
    assert.deepEqual(list.providers.map((p) => [p.name, p.configured]), [['groq', true], ['ollama', true], ['openai', false]]);

    const models = await (await fetch(`${url}/api/providers/ollama/models`)).json();
    assert.deepEqual(models.models, ['ollama-default', 'ollama-a', 'ollama-b']); // default model always listed

    const chat = (body) => fetch(`${url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation: [{ role: 'user', text: 'hi' }], ...body }) });
    const ok = await (await chat({ provider: 'ollama', model: 'qwen3:4b' })).json();
    assert.equal(ok.reply, 'answered by ollama');
    assert.equal(ok.model, 'qwen3:4b');
    assert.deepEqual(seen.at(-1), ['ollama', 'qwen3:4b']);

    await chat({});
    assert.deepEqual(seen.at(-1), ['groq', 'groq-default']); // falls back to the default provider

    assert.equal((await chat({ provider: 'openai' })).status, 503);  // not configured
    assert.equal((await chat({ provider: 'nope' })).status, 400);
    assert.equal((await chat({ provider: 'groq', model: 'bad model!' })).status, 400);
  } finally {
    srv.close();
  }
});

test('POST /api/chat streams progress events and the result as NDJSON', async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ conversation: [{ role: 'user', text: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/x-ndjson/);
  const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events[0].type, 'thinking');
  assert.equal(events.at(-1).type, 'result');
  assert.equal(events.at(-1).reply, 'Hello from the agent.');
  assert.equal(events.at(-1).model, 'fake-1');
});

test('streamed model errors arrive as an error event', async () => {
  const failing = { ...llm, chat: async () => { throw Object.assign(new Error('bad key'), { status: 401 }); } };
  const srv = createApp({ llm: failing }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ conversation: [{ role: 'user', text: 'hi' }] }),
    });
    const last = JSON.parse((await res.text()).trim().split('\n').at(-1));
    assert.equal(last.type, 'error');
    assert.equal(last.status, 502);
    assert.match(last.error, /rejected the request \(401\)/);
  } finally {
    srv.close();
  }
});
