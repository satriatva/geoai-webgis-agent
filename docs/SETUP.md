# Setup and prerequisites

How to run GeoAI WebGIS Agent locally with each model provider. The short version is in the [README](../README.md#quick-start).

## 1. Common requirements

| Requirement | Version / note | Check |
| --- | --- | --- |
| [Node.js](https://nodejs.org) | 18.17 or newer (20 LTS or 22 LTS recommended) | `node -v` |
| npm | comes with Node.js | `npm -v` |
| Git | to clone the repository | `git --version` |
| Internet access | always needed for OpenStreetMap services (Nominatim, Overpass) and map tiles | |
| A model provider | one of the options in section 2 | |

```bash
git clone https://github.com/satriatva/geoai-webgis-agent.git
cd geoai-webgis-agent
npm install
cp .env.example .env        # Windows CMD: copy .env.example .env
```

Then configure one provider in `.env` and start the app:

```bash
npm run dev                 # http://localhost:3000, restarts on changes in src/
npm test                    # optional: 44 offline tests, no API key needed
```

Pick the provider and model in the app header. Every provider with a key in `.env` can be selected (Ollama needs no key); the others are listed as "(add API key)". `LLM_PROVIDER` only sets the default, and the app remembers your last choice in the browser.

After pulling a new version, run `npm install` again: the map library and fonts are served from `node_modules`.

## 2. Choose a model provider

The model must support tool (function) calling. You can configure several providers at once:

| Provider | Cost | Needs | `.env` |
| --- | --- | --- | --- |
| Google Gemini | free tier with daily limits | API key | `LLM_PROVIDER=gemini`, `GEMINI_API_KEY=...` |
| Ollama (local) | free, open source | disk space, RAM, Ollama installed | `LLM_PROVIDER=ollama`, `LLM_MODEL=qwen3:8b` |
| Groq | free tier with rate limits | API key | `LLM_PROVIDER=groq`, `GROQ_API_KEY=...` |
| OpenRouter | free `:free` models, paid others | API key | `LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY=...` |
| OpenAI | paid | API key | `LLM_PROVIDER=openai`, `OPENAI_API_KEY=...` |
| Other OpenAI-compatible server | depends | base URL | `LLM_PROVIDER=custom`, `LLM_BASE_URL=...`, `LLM_MODEL=...` |

Free-tier limits and free model lists change often; check the provider's own page.

### Google Gemini

1. Create a key at [Google AI Studio](https://aistudio.google.com/apikey).
2. `.env`:
   ```
   LLM_PROVIDER=gemini
   GEMINI_API_KEY=your-key
   # optional, looser free limits than gemini-2.5-flash:
   # LLM_MODEL=gemini-2.5-flash-lite
   ```
3. One question uses several model calls (one per agent step). If you hit `429 rate limit`, wait a minute, pick a lighter model, or check your limits under **Rate Limit** in AI Studio.

### Ollama (local, open source)

**Hardware guide** (4-bit quantised models, CPU or GPU):

| Model | Download | Free RAM needed (approx.) | Notes |
| --- | --- | --- | --- |
| `qwen3:4b` | 2.5 GB | 4 GB | Lightest option with reliable tool calling, 256K context |
| `qwen3:8b` (default) | 5.2 GB | 7 GB | Best balance of quality and speed |
| `llama3.1:8b` | 4.9 GB | 7 GB | Alternative model family |
| `qwen3:14b` | 9.3 GB | 12 GB | Better reasoning, slower on CPU |
| 27B+ models (e.g. `qwen3.8:27b`) | 18 GB+ | 20 GB+ | Needs a large GPU; very slow on CPU |

"Free RAM" means memory not used by other applications. Without a GPU, each agent step can take 10 to 60 seconds.

**Steps**

1. Install Ollama from [ollama.com/download](https://ollama.com/download) and check it: `ollama --version`.
2. Download a model (one-time, needs internet):
   ```bash
   ollama pull qwen3:8b
   ollama list               # confirm it is installed
   ```
3. Give the model a larger context window. Tool results, such as a list of hospitals, do not fit in a small default window and the agent loses track.

   Windows, persistent (then quit Ollama from the system tray and start it again):
   ```powershell
   setx OLLAMA_CONTEXT_LENGTH 8192
   ```
   Windows, current Command Prompt (CMD) session only:
   ```bat
   set OLLAMA_CONTEXT_LENGTH=8192
   ollama serve
   ```
   Windows, current PowerShell session only:
   ```powershell
   $env:OLLAMA_CONTEXT_LENGTH=8192; ollama serve
   ```
   macOS / Linux:
   ```bash
   OLLAMA_CONTEXT_LENGTH=8192 ollama serve
   ```
4. `.env`:
   ```
   LLM_PROVIDER=ollama
   LLM_MODEL=qwen3:8b
   # LLM_BASE_URL=http://localhost:11434/v1   (default; change for a remote Ollama)
   # LLM_TIMEOUT_MS=180000                    (raise if answers time out on CPU)
   ```
5. Quick check that Ollama answers: open http://localhost:11434 in a browser; it should say "Ollama is running".

Once downloaded, the model runs offline; only the map and OpenStreetMap tools need internet.

### Groq

1. Create a key at [console.groq.com](https://console.groq.com/keys).
2. `.env`: `LLM_PROVIDER=groq`, `GROQ_API_KEY=...` (default model `llama-3.3-70b-versatile`; any Groq model with tool use works via `LLM_MODEL`).

### OpenRouter

1. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. `.env`: `LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY=...`. The model list in the app only shows models with tool support. Free `:free` variants come and go.

### OpenAI

`.env`: `LLM_PROVIDER=openai`, `OPENAI_API_KEY=...` (default `gpt-4o-mini`).

### LM Studio, vLLM or another OpenAI-compatible server

`.env`: `LLM_PROVIDER=custom`, `LLM_BASE_URL=http://localhost:1234/v1` (LM Studio's default), `LLM_MODEL=<model id>`, and `LLM_API_KEY` only if the server needs one.

## 3. Settings

All settings live in `.env`; [`.env.example`](../.env.example) lists them with comments.

| Variable | Default | Description |
| --- | --- | --- |
| `LLM_PROVIDER` | `gemini` | Default provider: `gemini`, `ollama`, `groq`, `openrouter`, `openai` or `custom` |
| `LLM_MODEL` | provider default | Default model for that provider (`GEMINI_MODEL` also works for Gemini) |
| `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY` | none | One key per hosted provider |
| `LLM_BASE_URL` | provider default | API address for the default provider, for example a remote Ollama |
| `LLM_API_KEY` | none | Key for the default provider; overrides the provider-specific key |
| `LLM_TIMEOUT_MS` | `120000` | Timeout per model request for OpenAI-compatible providers |
| `MAX_AGENT_STEPS` | `6` | Model turns that may call tools before the agent must answer |
| `CONTACT_EMAIL` | none | Added to the User-Agent sent to OpenStreetMap services; set it before you deploy |
| `NOMINATIM_URL`, `OVERPASS_URL` | public servers | Point to your own instances for heavier use |
| `PORT` | `3000` | HTTP port |

## 4. Troubleshooting

| Message or symptom | Cause | Fix |
| --- | --- | --- |
| `... is not configured` in the chat | No key for the chosen provider | Add the key to `.env` and restart the server |
| `Cannot reach Ollama ... ECONNREFUSED` | Ollama is not running | Start Ollama (tray app or `ollama serve`) |
| `rejected the request (404)` with Ollama | Model not downloaded or name misspelled | Run `ollama list`, then `ollama pull <model>` |
| `took too long to answer` | Slow local model on CPU | Use `qwen3:4b`, close other apps, or raise `LLM_TIMEOUT_MS` |
| `rate limit or quota reached (429)` | Provider free-tier limit | Wait a minute, or pick another model or provider |
| Agent repeats a tool or ignores results (Ollama) | Context window too small | Set `OLLAMA_CONTEXT_LENGTH=8192` and restart Ollama |
| `rejected the request (400)` mentioning tools | Model has no tool-calling support | Choose a model tagged *tools* |
| Map tiles do not load | No internet or blocked tile server | Check the connection; tiles come from `tile.openstreetmap.org` |
| Plain fonts or a broken layout after an update | New dependencies not installed | Run `npm install` and restart |
| `EADDRINUSE: 3000` | Port already in use | Stop the other process or set `PORT=3001` in `.env` |
| No places found | Public Overpass server busy | Retry later or set `OVERPASS_URL` to another instance |

Server-side errors are printed in the terminal with an `[agent]` prefix.
