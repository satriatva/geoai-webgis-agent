/**
 * GeoAI WebGIS Agent - browser app.
 * Wires the conversation, the live agent progress, the map and the model picker together.
 */
import { askAgent } from './api.js';
import { escapeHtml, formatTextToHtml } from './format.js';
import { createMap } from './map.js';
import { createPicker } from './picker.js';
import { batchOf, linkifyPlaces, registerLayers, renderResults } from './results.js';

// Example questions on the start screen; `tools` tells users what the agent will do.
const EXAMPLES = [
  { q: 'Find hospitals within 2 km of Universitas Gadjah Mada', tools: 'Geocode, then nearby search' },
  { q: 'How far is Monas from Bundaran HI?', tools: 'Geocode twice, then measure distance' },
  { q: 'Draw a 1 km buffer around Malioboro and list the pharmacies inside it', tools: 'Geocode, buffer, nearby search' },
  { q: 'What is at the point I selected on the map?', tools: 'Reverse geocode (click the map first)' },
];

// Display names for the tools in src/tools/index.js.
const TOOL_LABELS = {
  geocode_place: 'Find place',
  reverse_geocode: 'Look up address',
  find_nearby_places: 'Search nearby places',
  measure_distance: 'Measure distance',
  create_buffer: 'Draw buffer',
};

const MOBILE = matchMedia('(max-width: 760px)');
const MAX_INPUT_HEIGHT = 160;
const COPY_FEEDBACK_MS = 1200;

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const form = $('chat-form');
const input = $('user-input');
const chatBox = $('chat-box');
const intro = $('intro');
const sendBtn = $('send-btn');
const legend = $('map-legend');
const pointChip = $('point-chip');

// ---------------------------------------------------------------------------
// Map and map collar
// ---------------------------------------------------------------------------

const geo = createMap({
  onPointSelected: ({ lat, lon }) => {
    $('point-label').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    pointChip.hidden = false;
  },
  onCursorMove: ({ lat, lon }) => { $('cursor-pos').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`; },
  onZoom: (z) => { $('zoom-level').textContent = `z${z}`; },
});

$('clear-point').addEventListener('click', () => {
  geo.clearSelection();
  pointChip.hidden = true;
});

// ---------------------------------------------------------------------------
// Theme, network status and the mobile chat/map switch
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme-toggle').setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  geo.refreshStyles();
}
applyTheme(document.documentElement.dataset.theme || 'light');
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', next); } catch { /* storage unavailable */ }
  applyTheme(next);
});

function setOnline(online) {
  const status = $('net-status');
  status.classList.toggle('offline', !online);
  status.querySelector('span').textContent = online ? 'Online' : 'Offline';
}
setOnline(navigator.onLine);
addEventListener('online', () => setOnline(true));
addEventListener('offline', () => setOnline(false));

function setView(view) {
  app.dataset.view = view;
  for (const btn of document.querySelectorAll('.view-switch button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === view));
  }
  if (view === 'map') {
    $('map-badge').hidden = true;
    requestAnimationFrame(() => geo.invalidate()); // the map was hidden, so Leaflet must re-measure
  }
}
document.querySelector('.view-switch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) setView(btn.dataset.view);
});
addEventListener('resize', () => geo.invalidate());

function showOnMap(layers) {
  geo.showLayers(layers);
  legend.hidden = false;
}

// ---------------------------------------------------------------------------
// Rendering of turns
// ---------------------------------------------------------------------------

const scrollToBottom = () => { chatBox.scrollTop = chatBox.scrollHeight; };

function addAction(container, label, onClick, title = label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'link-btn';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', () => onClick(btn));
  container.appendChild(btn);
  return btn;
}

function renderUserRow(text) {
  const row = document.createElement('div');
  row.className = 'turn-user';
  row.innerHTML = `<div class="bubble">${formatTextToHtml(text)}</div><div class="actions"></div>`;
  chatBox.appendChild(row);
  return { row, bubble: row.querySelector('.bubble'), actions: row.querySelector('.actions') };
}

/** Agent turn with a live work log; returns methods to update it as events arrive. */
function renderAgentRow() {
  const row = document.createElement('div');
  row.className = 'turn-agent';
  row.innerHTML = `
    <div class="agent-head"><img src="assets/icon.svg" alt="" />Agent</div>
    <details class="worklog" open>
      <summary>Working on it</summary>
      <ol class="steps"></ol>
      <div class="thinking">Reading the question</div>
    </details>
    <div class="answer"></div>
    <div class="actions"></div>`;
  chatBox.appendChild(row);
  scrollToBottom();

  const worklog = row.querySelector('.worklog');
  const list = row.querySelector('.steps');
  const thinking = row.querySelector('.thinking');
  const answer = row.querySelector('.answer');
  const actions = row.querySelector('.actions');
  const started = performance.now();
  let modelCalls = 0;

  const stepHtml = (tool, args) =>
    `<span class="mark"></span><span class="tool">${escapeHtml(TOOL_LABELS[tool] ?? tool)}</span><span class="ms"></span>` +
    `<code>${escapeHtml(JSON.stringify(args ?? {}))}</code>`;

  function onEvent(event) {
    if (event.type === 'thinking') {
      modelCalls++;
      thinking.textContent = modelCalls === 1 ? 'Reading the question' : 'Deciding the next step';
      thinking.hidden = false;
    } else if (event.type === 'tool') {
      thinking.hidden = true;
      const li = document.createElement('li');
      li.className = 'step running';
      li.innerHTML = stepHtml(event.tool, event.args);
      list.appendChild(li);
    } else if (event.type === 'step') {
      const { step } = event;
      let li = list.querySelector('.step.running');
      if (!li) { // duplicate calls finish without a 'tool' event
        li = document.createElement('li');
        li.innerHTML = stepHtml(step.tool, step.args);
        list.appendChild(li);
      }
      li.className = `step ${step.duplicate ? 'dup' : step.ok ? 'ok' : 'fail'}`;
      li.querySelector('.mark').textContent = step.duplicate ? '↺' : step.ok ? '✓' : '✕';
      li.querySelector('.ms').textContent = step.duplicate ? 'reused' : `${step.ms} ms`;
      if (!step.ok) li.title = step.error;
      if (step.duplicate) li.title = 'Repeated call: the earlier result was reused';
    }
    scrollToBottom();
  }

  function closeLog(steps = []) {
    thinking.remove();
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const n = steps.length;
    worklog.querySelector('summary').textContent = n
      ? `Used ${n} tool ${n === 1 ? 'call' : 'calls'} in ${seconds} s`
      : `Answered in ${seconds} s without tools`;
    worklog.open = false;
    if (!n) list.remove();
  }

  return { row, answer, actions, onEvent, closeLog };
}

// ---------------------------------------------------------------------------
// Conversation state: each turn keeps its row, so retry and edit can cut back to it.
// ---------------------------------------------------------------------------

const turns = []; // { role: 'user' | 'model', text, row }
const answerLayers = new Map(); // batch id -> layers of one answer
let controller = null; // AbortController of the running request

const isBusy = () => controller !== null;

function setBusy(busy) {
  chatBox.classList.toggle('busy', busy);
  input.disabled = busy;
  sendBtn.classList.toggle('stop', busy);
  sendBtn.setAttribute('aria-label', busy ? 'Stop the agent' : 'Send question');
  if (!busy) controller = null;
}

/** Remove every turn after `turn`, on screen and in the history. */
function truncateAfter(turn) {
  const index = turns.indexOf(turn);
  if (index === -1) return false;
  while (turn.row.nextElementSibling) turn.row.nextElementSibling.remove();
  turns.length = index + 1;
  return true;
}

function addUserTurn(text) {
  intro.hidden = true;
  const view = renderUserRow(text);
  const turn = { role: 'user', text, row: view.row };
  turns.push(turn);
  addAction(view.actions, 'Edit', () => startEdit(turn, view), 'Edit this question and ask again');
  return turn;
}

/** Ask the agent to answer `userTurn`, the last turn in the history. */
async function requestAnswer(userTurn) {
  controller = new AbortController();
  setBusy(true);
  const view = renderAgentRow();
  const retry = () => {
    if (isBusy() || !truncateAfter(userTurn)) return;
    requestAnswer(userTurn);
  };

  try {
    const data = await askAgent(
      {
        conversation: turns.map(({ role, text }) => ({ role, text })),
        mapContext: geo.context(),
        ...picker.selection(),
      },
      { onEvent: view.onEvent, signal: controller.signal },
    );

    const reply = data.reply || 'No answer was returned.';
    view.closeLog(data.steps);
    view.answer.innerHTML = formatTextToHtml(reply);

    if (data.layers?.length) {
      const { batch, items } = registerLayers(data.layers);
      answerLayers.set(batch, data.layers);
      linkifyPlaces(view.answer, items);
      if (items.length) view.answer.insertAdjacentElement('afterend', renderResults(items));
      showOnMap(data.layers);
      if (MOBILE.matches && app.dataset.view === 'chat') {
        const badge = $('map-badge');
        badge.textContent = String(items.length || data.layers.length);
        badge.hidden = false;
      }
      addAction(view.actions, 'Show on map', () => { showOnMap(data.layers); if (MOBILE.matches) setView('map'); });
    }

    addAction(view.actions, 'Copy', async (btn) => {
      try { await navigator.clipboard.writeText(reply); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
      setTimeout(() => { btn.textContent = 'Copy'; }, COPY_FEEDBACK_MS);
    });
    addAction(view.actions, 'Retry', retry, 'Generate a new answer to the same question');
    if (data.providerLabel) {
      view.actions.insertAdjacentHTML('beforeend', `<span class="via" title="Provider and model that answered">${escapeHtml(data.providerLabel)} / ${escapeHtml(data.model)}</span>`);
    }
    turns.push({ role: 'model', text: reply, row: view.row });
  } catch (err) {
    view.closeLog();
    const stopped = err.name === 'AbortError';
    const message = stopped ? 'Stopped. Ask again or retry when you are ready.'
      : err.name === 'TimeoutError' ? 'The request timed out. Try a smaller model or a narrower question.'
      : err.message;
    view.answer.innerHTML = `<p class="${stopped ? 'stopped' : 'error'}">${escapeHtml(message)}</p>`;
    addAction(view.actions, 'Retry', retry, 'Send the same question again');
  } finally {
    setBusy(false);
    input.focus();
    scrollToBottom();
  }
}

/** Inline editor on a sent question. Sending cuts the conversation back to it and asks again. */
function startEdit(turn, view) {
  if (isBusy() || view.row.classList.contains('editing')) return;
  view.row.classList.add('editing');
  const original = view.bubble.innerHTML;
  view.bubble.innerHTML = `
    <textarea class="edit-input" rows="2" aria-label="Edit question"></textarea>
    <div class="edit-actions">
      <button type="button" class="btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn-primary" data-act="send">Ask again</button>
    </div>`;
  const box = view.bubble.querySelector('.edit-input');
  box.value = turn.text;
  autosize(box);
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);

  const close = () => view.row.classList.remove('editing');
  const cancel = () => { view.bubble.innerHTML = original; close(); };
  const send = () => {
    const text = box.value.trim();
    if (!text || isBusy()) return;
    if (!truncateAfter(turn)) return cancel();
    turn.text = text;
    view.bubble.innerHTML = formatTextToHtml(text);
    close();
    requestAnswer(turn);
  };

  box.addEventListener('input', () => autosize(box));
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape') cancel();
  });
  view.bubble.querySelector('[data-act="cancel"]').addEventListener('click', cancel);
  view.bubble.querySelector('[data-act="send"]').addEventListener('click', send);
}

function ask(text) {
  if (isBusy()) return;
  // A question whose answer failed stays on screen but leaves the history, so the
  // conversation sent to the model always alternates user / model.
  if (turns.at(-1)?.role === 'user') {
    const failed = turns.pop();
    failed.row.classList.add('stale');
    failed.row.nextElementSibling?.classList.add('stale');
  }
  requestAnswer(addUserTurn(text));
}

function newChat() {
  controller?.abort();
  turns.length = 0;
  answerLayers.clear();
  for (const el of [...chatBox.children]) if (el !== intro) el.remove();
  intro.hidden = false;
  geo.clearResults();
  legend.hidden = true;
  $('map-badge').hidden = true;
  input.value = '';
  autosize();
  input.focus();
}
$('new-chat').addEventListener('click', newChat);

// Place links and result items share one handler: zoom to the feature and open its popup.
chatBox.addEventListener('click', (e) => {
  const el = e.target.closest('[data-fid]');
  if (!el) return;
  const layers = answerLayers.get(batchOf(el.dataset.fid));
  if (!layers) return;
  if (MOBILE.matches) setView('map');
  if (geo.focusFeature(layers, el.dataset.fid)) legend.hidden = false;
  chatBox.querySelectorAll('.result-item.active').forEach((b) => b.classList.remove('active'));
  if (el.classList.contains('result-item')) el.classList.add('active');
});

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function autosize(el = input) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
}
input.addEventListener('input', () => autosize());
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (isBusy()) { controller.abort(); return; } // the send button doubles as Stop
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autosize();
  ask(text);
});
// While busy the textarea is disabled, so `required` would block the Stop click.
sendBtn.addEventListener('click', (e) => {
  if (isBusy()) { e.preventDefault(); controller.abort(); }
});

const examples = $('examples');
for (const { q, tools } of EXAMPLES) {
  const li = document.createElement('li');
  li.innerHTML = `<button type="button" class="example"><span class="q">${escapeHtml(q)}</span><span class="tools">${escapeHtml(tools)}</span></button>`;
  li.firstElementChild.addEventListener('click', () => ask(q));
  examples.appendChild(li);
}

// ---------------------------------------------------------------------------
// Model picker
// ---------------------------------------------------------------------------

const picker = createPicker(
  { providerSelect: $('provider-select'), modelSelect: $('model-select') },
  (message) => {
    const note = document.createElement('p');
    note.className = 'setup-note';
    note.textContent = message;
    intro.appendChild(note);
  },
);
