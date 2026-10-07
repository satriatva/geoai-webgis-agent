/**
 * Provider and model picker in the top bar. Every provider the server knows is listed;
 * providers without an API key are shown but disabled, so users can see what is available.
 */
import { escapeHtml } from './format.js';
import { getModels, getProviders } from './api.js';

const STORAGE_KEY = 'geoai.model';

/**
 * @param {object}   elements
 * @param {HTMLSelectElement} elements.providerSelect
 * @param {HTMLSelectElement} elements.modelSelect
 * @param {Function} [onUnavailable]  Called with a message when no provider can be used.
 * @returns {{ selection: () => ({ provider?: string, model?: string }) }}
 */
export function createPicker({ providerSelect, modelSelect }, onUnavailable = () => {}) {
  let providers = [];
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { /* storage unavailable */ }

  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ provider: providerSelect.value, model: modelSelect.value }));
    } catch { /* storage unavailable */ }
  };

  async function loadModels(name, preferred) {
    const provider = providers.find((p) => p.name === name);
    modelSelect.disabled = true;
    modelSelect.innerHTML = '<option>Loading models…</option>';

    let list = { models: [provider?.defaultModel].filter(Boolean), source: 'preset' };
    try { list = await getModels(name); } catch { /* keep the preset */ }

    // Free OpenRouter models first, then alphabetical.
    const models = [...new Set(list.models)].sort((a, b) => (b.endsWith(':free') - a.endsWith(':free')) || a.localeCompare(b));
    modelSelect.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    modelSelect.value = models.includes(preferred) ? preferred : provider?.defaultModel ?? models[0];
    modelSelect.title = list.source === 'live'
      ? `${models.length} models available from ${provider?.label}`
      : `Suggested models (live list unavailable${list.note ? `: ${list.note}` : ''})`;
    modelSelect.disabled = false;
    save();
  }

  async function init() {
    try {
      const data = await getProviders();
      providers = data.providers;
      providerSelect.innerHTML = providers
        .map((p) => {
          const note = !p.configured ? ' (add API key)' : p.local ? ' (local)' : '';
          return `<option value="${escapeHtml(p.name)}" ${p.configured ? '' : 'disabled'}>${escapeHtml(p.label + note)}</option>`;
        })
        .join('');

      const usable = providers.filter((p) => p.configured).map((p) => p.name);
      if (!usable.length) {
        providerSelect.disabled = true;
        onUnavailable('No model provider is configured. Add an API key (or set up Ollama) in .env, restart the server, then reload this page. See docs/SETUP.md.');
        return;
      }
      const start = [saved.provider, data.default].find((n) => usable.includes(n)) ?? usable[0];
      providerSelect.value = start;
      await loadModels(start, start === saved.provider ? saved.model : undefined);
    } catch {
      providerSelect.innerHTML = '<option>Server unavailable</option>';
      onUnavailable('Cannot reach the server. Check that it is running (npm run dev) and reload the page.');
    }
  }

  providerSelect.addEventListener('change', () => loadModels(providerSelect.value));
  modelSelect.addEventListener('change', save);
  init();

  return {
    selection: () => (providerSelect.value && !modelSelect.disabled ? { provider: providerSelect.value, model: modelSelect.value } : {}),
  };
}
