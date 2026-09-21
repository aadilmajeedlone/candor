# Running Candor for free

Candor is set up so that **nothing in the default configuration can cost money**: speech recognition runs on your PC, and the AI model can be a local model or a machine you already have access to. This page records what was checked, what is free, what is not, and the few things only you can do.

> **The rule this project follows:** no payment method is ever requested, no billing is enabled, no trial or prepaid credit is used, and nothing is chosen for you. If something cannot be shown to be free, it is not used. Cloud services stay available, clearly labelled, but only if *you* add them.

## What is used by default

| Part | What runs | Cost | Leaves your PC? |
|---|---|---|---|
| Speech recognition | On-device streaming model (sherpa-onnx, Apache-2.0), bundled in the installer | **Free** — no account, no key, works offline | Never |
| Question detection, retrieval, answer checking | Local code | Free | Never |
| AI model that writes answers | **Your choice** — not bundled (see below) | Local model or friend's GPU: free. Cloud: depends | The question and a few retrieved facts go to the model you choose |

## Choosing an AI model, free options first

| Option | Cost | Set up | Notes |
|---|---|---|---|
| **A friend's GPU** (OpenAI-compatible server: vLLM, llama.cpp `llama-server`, Ollama, LM Studio) | Free | *Settings → AI Providers → Add → "A friend's GPU or your own server"* | Fastest option if the GPU is decent. Needs the details in [What I need for a friend's GPU](#what-i-need-for-a-friends-gpu). |
| **Ollama / LM Studio / llama.cpp on this PC** | Free | Install one, download a small model, add the provider | Private and offline, but slow on a laptop without a GPU — see [measured numbers](#a-real-local-model-on-this-pc-measured). |
| **Google Gemini, AI Studio API key (free tier)** | Free *only while the key's project has no billing* | Key from <https://aistudio.google.com/apikey> | Low rate limits; on the free tier Google may use your content to improve its products. Requests from a project that has billing enabled are billed. Some organisations block API keys. |
| **Groq**, **OpenRouter** (`:free` models) | They advertise free plans / free models | Key from their site | Not verified from this PC. Free tiers change; check current limits and terms before relying on them. |
| **OpenAI**, **Anthropic** | **Paid** (prepaid credit) | — | A ChatGPT or Claude Pro subscription does **not** include API use. |
| **Google Vertex AI (Gemini via gcloud sign-in)** | **Paid** — needs a Google Cloud project with billing | — | See below. Candor will not enable billing. |

Candor shows, on the Live screen and in *Settings → AI Providers*, which model is answering and whether it runs on **this PC**, **your network** or the **internet** — an internet service may charge for use and Candor cannot see or limit what a provider bills.

### Google Gemini: what was checked

| Question | Answer |
|---|---|
| Is Google sign-in (ADC) implemented correctly? | It uses Google's official `google-auth-library` and is tested against that real library talking to a local stand-in for Google's token endpoint. It has **never been run against a real Google account**: no credentials exist on this PC, and `gcloud auth application-default login` needs a browser sign-in only you can do. |
| Can a project use Gemini **without billing**? | **Vertex AI: no** — Google's documentation requires a billing-enabled project. **Gemini API with an AI Studio API key: yes**, on Google's free tier. |
| Is your Google account/project controlled by an organisation? | The error you saw — *"Your organisation's security policy disallows API keys"* — is an organisation policy, so the Cloud project belongs to an organisation. It was not inspected and is not bypassed. |
| Are the required APIs usable without payment? | The Generative Language API (AI Studio key) has a free tier. Vertex AI's API can be switched on, but its calls are billed. |
| Does the model have genuinely free quota? | Not every Gemini model has free-tier quota. The models the old installer picked for you (a computer-use preview and a deep-research preview) had none; the current build ranks Flash/Flash-Lite first and probes alternatives. Limits change — see <https://ai.google.dev/gemini-api/docs/rate-limits>. |
| Could a test have charged you? | Yes, if the key's project has billing enabled. For that reason **no Google request was made** with any credential of yours while building this. |

**Decision:** the Vertex/ADC path is kept for people who already have billing, but it is labelled as needing billing and is never the default. For you, prefer a local model, a friend's GPU, or an AI Studio key that AI Studio itself shows as free of charge.

**To check that your key is on the free tier:** open Google AI Studio → *API keys*. The key's project shows its plan. If it says free of charge, use it; if it offers to *set up billing*, that is the free tier; if it says billing is enabled, do not use it for testing.

## A real local model on this PC (measured)

Everything here was measured on the development PC — AMD Ryzen 5 3500U (4 cores, 15 W laptop CPU), 13.9 GB RAM, integrated Radeon Vega 8, no NVIDIA GPU — with other applications open. The server is llama.cpp's official Windows CPU build running **Qwen2.5-1.5B-Instruct (Q4_K_M, Apache-2.0)**, reached through Candor's normal OpenAI-compatible provider path (`npm run test:local-llm`: nothing mocked).

| What | Measured |
|---|---|
| Server start (model load) | 5–7 s |
| Reading the prompt | **14–22 tokens/s** (both 4 and 8 threads) |
| Generating | **3.6–4.0 tokens/s** (about 3 words a second) |
| A ~440-token prompt with nothing cached | **≈ 22 s** before the first word |
| Same profile already cached, a short new question | first word after **1.0–1.9 s** |
| Through Candor, typed question, per-question retrieval (concise mode) | first word **12 s and 23 s** for the 2nd and 3rd question, **45 s** for the very first (it queued behind the prompt pre-warm); a 80–105-word answer finished in **48–72 s** |
| Vulkan build on the integrated GPU | crashed on this machine's Radeon driver (`vkQueueSubmit: Invalid queue`) — not usable here |

**What this means.** A small model on a laptop CPU is fine for *preparation* and for working offline, and Candor handles it correctly (streaming, generous timeouts instead of a 9-second cut-off, a plain "not running" message when the server is down). It is **not fast enough for live interviews on this PC**: the first word takes 12 seconds or more. Candor's prompt puts your profile first so a server with prompt caching (llama.cpp, vLLM) reuses it; only the per-question part is new, and that alone costs seconds on this CPU. A friend's GPU, or a hosted model, is what makes live answers fast.

Tips if you still want a local model: use the *Concise* answer mode, a 0.5–1.5B model, keep the interview linked to a short résumé, and start the session a minute before the interview so the prompt pre-warm finishes.

## What I need for a friend's GPU

Nothing about a friend's server was found anywhere in this project, in Candor's saved settings, or in the environment, and it was not guessed. To use it, Candor needs exactly these five things:

1. **API base URL** — for example `http://192.168.1.50:8000/v1` (same network), `http://100.101.102.103:8000/v1` (Tailscale) or `https://something.trycloudflare.com/v1` (a tunnel). It must end at the OpenAI-compatible root (usually `/v1`).
2. **Model id** — the exact name the server exposes (Candor lists them with *Test & fetch models*, which calls `GET /v1/models`).
3. **Authentication** — an API key/bearer token if the server requires one; none if it does not.
4. **Protocol** — OpenAI-compatible **chat completions** (`POST /v1/chat/completions`) with **streaming** (`"stream": true`, server-sent events). vLLM, llama.cpp `llama-server`, Ollama and LM Studio all provide this.
5. **Network reachability** from this PC: same Wi-Fi/LAN, a VPN such as Tailscale, or an `https` tunnel. Plain `http://` is accepted only for this PC, private networks (10.x, 172.16–31.x, 192.168.x), Tailscale (100.64–127.x, `*.ts.net`) and `*.local`; across the internet the address must be `https://`.

Suggested commands for the friend (any one of them):

```bash
# vLLM (NVIDIA GPU), with a key
vllm serve Qwen/Qwen2.5-7B-Instruct --host 0.0.0.0 --port 8000 --api-key SOME-LONG-RANDOM-TOKEN

# llama.cpp (any GPU/CPU), GGUF model
llama-server -m model.gguf --host 0.0.0.0 --port 8080 --api-key SOME-LONG-RANDOM-TOKEN

# Ollama
OLLAMA_HOST=0.0.0.0 ollama serve
```

Don't expose a server to the internet without a key; prefer Tailscale or a tunnel.

**If it is unreachable**, Candor says so about *that server* — "Could not reach Friend's GPU on your network. Check that the machine is on, its server is running, the address and port are right, and this PC is on the same network or VPN." — and never switches to another provider by itself. A fallback model is used only if you set one for the task, and a notice is shown when it takes over.

## Speech: why not Deepgram or AssemblyAI

Both stream audio to a server and both advertise *trial credit*, not a free tier, so they are off unless you add a key and choose them in *Settings → Speech recognition*. On-device recognition is free, private and, on this PC, as fast (see [SPEECH.md](SPEECH.md)).

## MANUAL ACTIONS (only you can do these)

1. **Install the new build** (`release/Candor-Setup-0.1.0.exe`) — close Candor first; your data is kept. It bundles the speech models, so speech works immediately.
2. **Allow the microphone** when Windows asks the first time (Settings → Privacy & security → Microphone).
3. **Pick an AI model** — Candor cannot choose one for you without an account or a server:
   * friend's GPU: send me / enter the five items above, or
   * a local model: install Ollama (<https://ollama.com>) and run `ollama pull llama3.2`, then add it in Settings, or
   * a free AI Studio key, checked as described above.
4. *(Optional)* Google sign-in (ADC) needs your browser: `gcloud auth application-default login` — only useful if your project already has billing.
