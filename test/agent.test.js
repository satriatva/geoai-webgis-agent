import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent.js';

/** Fake provider that replays scripted turns and records each request. */
function fakeLlm(turns) {
  const requests = [];
  return {
    name: 'fake',
    label: 'Fake',
    model: 'fake-1',
    configured: true,
    requests,
    chat: async (req) => {
      requests.push(structuredClone(req));
      const next = turns.shift();
      if (!next) throw new Error('no more scripted turns');
      if (next instanceof Error) throw next;
      return { text: next.text ?? '', toolCalls: next.calls ?? [] };
    },
  };
}

const toolset = {
  geocode_place: {
    declaration: { name: 'geocode_place', description: 'geocode', parameters: { type: 'object', properties: {} } },
    run: async ({ query }) => ({
      data: { candidates: [{ name: query, lat: -6.1754, lon: 106.8272 }] },
      geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [106.8272, -6.1754] }, properties: {} }] },
    }),
  },
};
const ask = (text) => [{ role: 'user', text }];

test('runs the tool loop and returns the answer, trace and map layers', async () => {
  const llm = fakeLlm([
    { calls: [{ id: 'c1', name: 'geocode_place', args: { query: 'Monas' } }] },
    { text: 'Monas is at -6.1754, 106.8272.' },
  ]);
  const out = await runAgent({ llm, toolset, conversation: ask('Where is Monas?') });

  assert.equal(out.reply, 'Monas is at -6.1754, 106.8272.');
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].ok, true);
  assert.equal(out.layers.length, 1);

  // The second request carries the assistant's tool call and the tool result in neutral form.
  const msgs = llm.requests[1].messages;
  assert.equal(msgs.at(-2).role, 'assistant');
  assert.equal(msgs.at(-2).toolCalls[0].name, 'geocode_place');
  assert.equal(msgs.at(-1).role, 'tool');
  assert.equal(msgs.at(-1).results[0].id, 'c1');
  assert.equal(msgs.at(-1).results[0].response.result.candidates[0].name, 'Monas');
});

test('maps earlier model turns to the assistant role', async () => {
  const llm = fakeLlm([{ text: 'ok' }]);
  await runAgent({ llm, toolset, conversation: [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }, { role: 'user', text: 'c' }] });
  assert.deepEqual(llm.requests[0].messages.map((m) => m.role), ['user', 'assistant', 'user']);
});

test('reports tool errors back to the model instead of failing', async () => {
  const llm = fakeLlm([
    { calls: [{ id: 'x', name: 'does_not_exist', args: {} }] },
    { text: 'Sorry, that tool is unavailable.' },
  ]);
  const out = await runAgent({ llm, toolset, conversation: ask('hi') });
  assert.equal(out.steps[0].ok, false);
  assert.match(llm.requests[1].messages.at(-1).results[0].response.error, /unknown tool/);
});

test('stops after maxSteps and asks for a final answer with tools disabled', async () => {
  const loop = { calls: [{ id: 'l', name: 'geocode_place', args: { query: 'x' } }] };
  const llm = fakeLlm([loop, loop, { text: 'Final answer.' }]);
  const out = await runAgent({ llm, toolset, maxSteps: 2, conversation: ask('loop') });
  assert.equal(out.truncated, true);
  assert.equal(out.reply, 'Final answer.');
  assert.equal(llm.requests[2].allowTools, false);
});

test('adds the map context to the system prompt', async () => {
  const llm = fakeLlm([{ text: 'ok' }]);
  await runAgent({ llm, toolset, conversation: ask('what is here?'), mapContext: { selectedPoint: { lat: -7.7, lon: 110.4 } } });
  assert.match(llm.requests[0].system, /User-selected point: lat -7.7, lon 110.4/);
});

test('retries transient errors, then succeeds', async () => {
  const llm = fakeLlm([
    Object.assign(new Error('overloaded'), { status: 503 }),
    Object.assign(new Error('quota "retryDelay": "0.01s"'), { status: 429 }),
    { text: 'ok after retry' },
  ]);
  const out = await runAgent({ llm, toolset, retry: { baseDelayMs: 5 }, conversation: ask('hi') });
  assert.equal(out.reply, 'ok after retry');
  assert.equal(llm.requests.length, 3);
});

test('does not retry non-transient errors', async () => {
  const llm = fakeLlm([Object.assign(new Error('bad key'), { status: 400 })]);
  await assert.rejects(runAgent({ llm, toolset, retry: { baseDelayMs: 5 }, conversation: ask('hi') }), /bad key/);
  assert.equal(llm.requests.length, 1);
});

test('returns an explanation instead of an empty reply when tools keep failing', async () => {
  const llm = fakeLlm([{ calls: [{ id: 'x', name: 'does_not_exist', args: {} }] }, { text: '' }]);
  const out = await runAgent({ llm, toolset, conversation: ask('hi') });
  assert.match(out.reply, /tool kept failing.*unknown tool/);
});

test('repeated identical tool calls reuse the first result instead of running again', async () => {
  let runs = 0;
  const counting = { geocode_place: { ...toolset.geocode_place, run: async (a) => { runs++; return toolset.geocode_place.run(a); } } };
  const call = { calls: [{ id: 'c', name: 'geocode_place', args: { query: 'Malioboro' } }] };
  const llm = fakeLlm([call, call, { text: 'done' }]);
  const out = await runAgent({ llm, toolset: counting, conversation: ask('x') });
  assert.equal(runs, 1);
  assert.equal(out.steps[1].duplicate, true);
  assert.match(llm.requests[2].messages.at(-1).results[0].response.note, /Duplicate call/);
});

test('a failing final answer after the step limit still returns a helpful reply', async () => {
  const loop = { calls: [{ id: 'l', name: 'geocode_place', args: { query: 'x' } }] };
  const llm = fakeLlm([loop, Object.assign(new Error('Tool choice is none, but model called a tool'), { status: 400 })]);
  const out = await runAgent({ llm, toolset, maxSteps: 1, conversation: ask('loop') });
  assert.equal(out.truncated, true);
  assert.match(out.reply, /limit of 1 tool calls.*geocode_place/);
});

test('reports progress through onEvent', async () => {
  const llm = fakeLlm([
    { calls: [{ id: 'c1', name: 'geocode_place', args: { query: 'Monas' } }] },
    { text: 'done' },
  ]);
  const events = [];
  await runAgent({ llm, toolset, conversation: ask('Where is Monas?'), onEvent: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => e.type), ['thinking', 'tool', 'step', 'thinking']);
  assert.equal(events[1].tool, 'geocode_place');
  assert.equal(events[2].step.ok, true);
});
