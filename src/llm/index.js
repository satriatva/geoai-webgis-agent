import { createGeminiProvider } from './gemini.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import { APP_NAME, REPO_URL } from '../config.js';

const DEFAULT_TIMEOUT_MS = 120000;

/** Model-list filter that drops ids matching `re` (embeddings, speech, moderation, ...). */
const notChat = (re) => (m) => !re.test(m.id);

/**
 * Provider presets. Everything except Gemini speaks the OpenAI Chat Completions format,
 * so adding a provider is one entry here. `models` is the fallback list shown when the
 * provider's live /models endpoint cannot be reached.
 */
export const PRESETS = {
  gemini: {
    label: 'Google Gemini',
    model: 'gemini-2.5-flash',
    keyEnv: 'GEMINI_API_KEY',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyEnv: 'GROQ_API_KEY',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen/qwen3-32b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    filterModels: notChat(/whisper|guard|tts|playai|orpheus|prompt-guard|distil/i),
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyEnv: 'OPENROUTER_API_KEY',
    // OpenRouter uses these optional headers to attribute traffic to the app.
    headers: { 'HTTP-Referer': REPO_URL, 'X-Title': APP_NAME },
    models: ['meta-llama/llama-3.3-70b-instruct:free'],
    // Keep only models that declare tool (function calling) support.
    filterModels: (m) => (m.supported_parameters ?? []).includes('tools'),
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyEnv: 'OPENAI_API_KEY',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
    filterModels: (m) => /^(gpt-|o\d)/.test(m.id) && !/audio|realtime|transcribe|tts|image|search|instruct/i.test(m.id),
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    requiresKey: false,
    local: true,
    models: ['qwen3:8b', 'qwen3:4b', 'llama3.1:8b'],
    filterModels: notChat(/embed/i),
  },
  // Any other OpenAI-compatible server (LM Studio, vLLM, LocalAI, ...): set LLM_BASE_URL and LLM_MODEL.
  custom: { label: 'OpenAI-compatible', baseUrl: '', model: '', keyEnv: 'LLM_API_KEY', requiresKey: false, local: true },
};

/** Create one provider from its preset and the environment. */
function build(name, env, { useOverrides: requested }) {
  const useOverrides = requested || name === 'custom'; // `custom` is defined only by the LLM_* variables
  const preset = PRESETS[name];
  const apiKey = (useOverrides && env.LLM_API_KEY) || (preset.keyEnv ? env[preset.keyEnv] : '') || '';
  const model =
    (useOverrides && env.LLM_MODEL) || (name === 'gemini' ? env.GEMINI_MODEL : '') || preset.model;

  if (name === 'gemini') return createGeminiProvider({ apiKey, model, models: preset.models });

  return createOpenAICompatibleProvider({
    name,
    label: preset.label,
    baseUrl: (useOverrides && env.LLM_BASE_URL) || preset.baseUrl,
    apiKey,
    model,
    headers: preset.headers,
    requiresKey: preset.requiresKey ?? true,
    timeoutMs: Number(env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    models: preset.models,
    filterModels: preset.filterModels,
    local: preset.local ?? false,
  });
}

/** Build the provider selected by LLM_PROVIDER (default: gemini). */
export function createProvider(env = process.env) {
  const name = (env.LLM_PROVIDER || 'gemini').toLowerCase();
  if (!PRESETS[name]) {
    throw new Error(`Unknown LLM_PROVIDER "${env.LLM_PROVIDER}". Use one of: ${Object.keys(PRESETS).join(', ')}.`);
  }
  return build(name, env, { useOverrides: true });
}

/**
 * Build every provider so users can switch in the UI. LLM_MODEL / LLM_BASE_URL / LLM_API_KEY
 * apply to the default provider (LLM_PROVIDER) only; the others use their own keys and defaults.
 * The `custom` provider is included only when LLM_BASE_URL is set.
 */
export function createProviders(env = process.env) {
  const defaultProvider = createProvider(env);
  const providers = { [defaultProvider.name]: defaultProvider };
  for (const name of Object.keys(PRESETS)) {
    if (providers[name]) continue;
    if (name === 'custom' && !env.LLM_BASE_URL) continue;
    providers[name] = build(name, env, { useOverrides: false });
  }
  return { providers, defaultName: defaultProvider.name };
}
