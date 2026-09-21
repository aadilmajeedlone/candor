# Candor

An interview assistant for the Windows desktop: prepare from your real résumé and the job description, practise with mock interviews, and — when you choose to — get a streamed, first-person answer within a fraction of a second of the question ending. Every answer is built only from your own experience; when Candor has nothing to draw on, it says so instead of inventing something.

Candor is an original application. It is inspired by the category of interview-copilot tools but shares no code, branding or interface with any of them.

> **Use it honestly.** Many interviews and employers prohibit AI assistance during the conversation. Whether and where you use the live mode is your responsibility. Candor does not hide itself from screen sharing, does not touch your meeting software, and will not capture audio until you explicitly start listening (see [docs/PRIVACY.md](docs/PRIVACY.md)). Preparation and mock interviews have no such concerns.

---

## What it does

| Area | What you get |
|---|---|
| **Preparation** | Upload a résumé (PDF / DOCX / TXT) and paste a job description. Candor extracts structured facts, compares them with the role (strong / partial / missing / transferable), and generates *About me*, *Company*, *Role* and *Likely questions* sections plus a personalised answer for each question. Works offline with a local parser; a model improves it when one is configured. |
| **Live interview** | Left: rolling transcript. Centre: the detected question. Right: the streamed answer. Bottom: status, measured latency, microphone level, model and controls. Seven answer modes (Concise, Standard, Detailed, Bullets, STAR, Technical, Follow-up), follow-up handling, *Shorter / Expand / More conversational / Add my experience / Regenerate / Copy*, and a feedback loop (“too generic”, “incorrect”, …). |
| **Low latency** | Local voice-activity detection, **on-device streaming speech recognition** (partial words while the interviewer is still talking), speculative answer generation that starts before the question ends, a cached and pre-warmed prompt, local retrieval, streaming first-token painting, and automatic fallback between the models and speech engines *you* configured. All timings shown are measured, never estimated. |
| **Honesty** | Facts extracted by a model are dropped unless they appear in your source text; answers are checked against your facts and unsupported numbers or names are highlighted; a confidence indicator shows how well the question matched your material. |
| **Mock interviews** | Timed practice with spoken or typed answers, measured statistics (words, pace, fillers, STAR coverage) and model feedback that never invents a score. |
| **Library** | Story bank (STAR), ~150 seeded questions in 15 categories, searchable history with delete / export / purge. |
| **Free by default** | **Speech recognition runs on this PC**: free, private (audio never leaves it), offline, no account or key. The AI model can be a local one (Ollama, LM Studio, llama.cpp) or **a friend's GPU** (any OpenAI-compatible server over your LAN, Tailscale or an https tunnel). Cloud services are opt-in and labelled with what they cost. Details, measurements and what only you can do: [docs/FREE-OPTIONS.md](docs/FREE-OPTIONS.md), [docs/SPEECH.md](docs/SPEECH.md). |
| **Providers** | OpenAI-compatible (Ollama, LM Studio, llama.cpp, vLLM, a friend's server, OpenAI, Groq, OpenRouter…), Anthropic and Google Gemini (API key, or Google sign-in — which uses Vertex AI and therefore needs billing). Deepgram and AssemblyAI are optional cloud speech engines. Separate routing for live answers, preparation, classification and mock interviews, each with a fallback *you* choose; the Live screen always shows which model and which speech engine is answering and whether it runs on this PC, your network or the internet. |
| **Comfort** | Dark / light / system theme, high-contrast mode, font scaling, reduced motion, keyboard-operable UI, configurable global hotkeys, guided first-run setup. Layout is tested at 1280×720, 1920×1080 and 2560×1440. |

---

## Status: what is verified, and how

Nothing below is a claim about speed or quality that was not measured.

| Check | How | Result |
|---|---|---|
| Type safety | `npm run typecheck` (TypeScript strict, three projects) | clean |
| Lint | `npm run lint` (typescript-eslint type-aware rules incl. `no-floating-promises`, React hooks rules, no raw-HTML rendering, no `console` in the main process) | 0 findings |
| Unit + integration | `npm test` — 536 tests, among them the structured-reply pipeline: a tolerant JSON extractor (cut-off salvage, every possible truncation point), the retry and fallback policy, native schemas and provider quirks against real HTTP servers, streaming replies cut at every byte or ended early, and the whole “About me” path including a 40-run random-failure test. Question detection, retrieval, the live engine (fake clock), PDF/DOCX parsing, the AI gateway against a **real local HTTP server** speaking the OpenAI / Anthropic / Gemini wire formats, cloud speech providers against a **real local WebSocket server**, the on-device speech host (start, share, crash, recover, lag, idle, fallback) against a scripted stand-in for the native library, provider addresses and error wording, and the whole app flow through the real IPC handlers and SQLite | pass |
| **On-device speech, real engine** | `npm run test:speech` — 16 tests run the **real** speech engine (both models) on real audio: accuracy, partial results, a question recognised before it is finished, real-time factor, end-of-utterance, and the whole host → worker → engine path | pass |
| **Real local language model** | `npm run test:local-llm` — Candor against a **real llama.cpp server** running Qwen2.5-1.5B on this CPU (no mock): model listing, connection test, streamed answers to typed questions, a stopped server reported plainly, and “About me” generated through the real app path with a 300- and a 700-token model ceiling. Numbers in [Measured performance](#measured-performance) | pass |
| End-to-end | `npx playwright test` — 30 tests drive the **real Electron app** (7 of them put “About me” through a cut-off reply, an unusable reply, a provider error and a slow model, and can be pointed at the packaged exe with `ABOUT_E2E_MODE=packaged`): onboarding → providers → résumé/JD → preparation → live (typed, and audio through a fake microphone device) → mock interview → history → settings; **a recorded question played into the fake microphone is recognised on-device and answered**; a real WASAPI loopback stream; a denied-microphone run; the Google sign-in screens with no Google credentials on the PC; layout at three window sizes; renderer sandbox and CSP checks | pass |
| Packaged app | the built `Candor.exe` is launched over the DevTools protocol (fuses hardened, asar integrity on) and **the bundled speech model loads and transcribes inside the packaged layout** (worker thread and native library unpacked from the asar); the NSIS installer was installed silently, tested, and uninstalled cleanly (files, shortcuts, registry) on an earlier build; the latest installer was rebuilt but not re-installed, because Candor is installed and running on the build PC | pass |
| **Real third-party services** | **Not run, deliberately.** Nothing here may cost money, and no free credentials were available. The cloud adapters (OpenAI, Anthropic, Gemini, Deepgram, AssemblyAI) follow the documented wire formats and are exercised against local servers that imitate them. A **friend's GPU** was never reachable from where this was built (its address was not provided). Real interviewer audio (a video call) was not available either: speech accuracy was measured on synthetic voices, real read speech and simulated noise. Use *Settings → AI Providers → Test* and *Settings → Speech recognition → Test speech recognition* on your own machine. | unverified |

---

## Quick start (development)

Requirements: Windows 10/11, Node.js ≥ 22.12 (developed on 24), npm.

```bash
npm install
npm run models       # first checkout only: fetch + verify the on-device speech models (231 MB, pinned by SHA-256)
npm run dev          # electron-vite dev server with hot reload
```

Other commands:

```bash
npm run typecheck    # tsc, strict, main + renderer + e2e projects
npm run lint         # eslint (type-aware)
npm test             # 536 unit + integration tests (about 20 s)
npm run test:speech  # the real speech engine on real audio (about 2 minutes)
npm run llm:fetch    # (optional) download llama.cpp + a small open model for the next command (1.1 GB, verified)
npm run test:local-llm  # Candor against a real llama.cpp server (needs the files from llm:fetch)
npm run check        # typecheck + lint + test + test:speech
npm run test:e2e     # builds, then runs the Playwright suite against the real app
npm run bench        # measures the local (non-network) latency pipeline on this machine
npm run bench:stt    # speech engine: latency, CPU, memory, accuracy (real worker thread, real-time audio)
npm run bench:robustness  # speech accuracy on noisy / telephone-band / quiet / echoing audio
npm run build        # production bundles into ./out
npm run dist:dir     # unpacked Windows app in ./release/win-unpacked
npm run dist         # NSIS installer in ./release (Candor-Setup-<version>.exe)
```

If Electron reports that its binary is missing (npm can skip install scripts), run `node node_modules/electron/install.js` once.

## Configure the AI providers

**In the app (recommended).** The first-run guide walks through this; later: *Settings → AI Providers*.

1. Choose a service — free options are listed first: **Ollama / LM Studio on this PC**, **a friend's GPU or your own server** (type its address), **Google Gemini with an AI Studio key** (free tier), then Groq, OpenRouter and the paid services (OpenAI, Anthropic, Vertex AI) — and paste the key if it needs one. Keys are encrypted with Windows DPAPI (Electron `safeStorage`) and never shown again — only a hint such as `…7890`. Every provider shows where it runs: **This PC**, **Your network** or **Internet**.
2. *Settings → Models*: pick a **fast model** for live answers and a **higher-quality model** for preparation (*Quick setup* does both from one provider). Each task can have a fallback; if one model fails, Candor switches and tells you.
3. *Settings → Speech recognition*: nothing to do — it runs on this PC. Press **Test speech recognition** to see it transcribe a built-in recording and to see how fast it starts on your machine. A cloud engine (Deepgram, AssemblyAI) can be added under *Cloud speech services* and chosen explicitly; it is never used unless you set it up.

The model names offered by the presets are suggestions; use *List models* to see what your account can actually call.

**Google without an API key.** If your organisation blocks API keys (“API keys are disallowed … use Application Default Credentials”), choose **Google (Gemini) — sign in with gcloud, no API key** instead. Run `gcloud auth application-default login`, set your project, and Candor uses that login through Google's official auth library — no key is stored or needed. Step-by-step Windows instructions, the two endpoints (Vertex AI, Gemini API) and every message you might see are in [docs/GOOGLE-ADC.md](docs/GOOGLE-ADC.md); the same steps, with copy buttons, are in the provider form. *Check sign-in* tells you exactly what is missing.

**From the environment.** Copy [`.env.example`](.env.example) to `.env` (development: next to `package.json`; installed app: `%APPDATA%\Candor\.env`). Supported: `OPENAI_API_KEY` (for a provider at `api.openai.com`), `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` / `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY`, `STT_API_KEY`. You still add the provider entry in Settings and leave its key empty. A key stored in Settings takes priority. Environment keys are held in memory only.

**Local models and a friend's GPU.** Ollama, LM Studio, llama.cpp (`llama-server`), vLLM and anything else that speaks the OpenAI chat-completions API with streaming work. Plain `http://` is accepted for this PC and for private networks — a LAN address (10.x, 172.16–31.x, 192.168.x), a Tailscale address (100.64–127.x or `*.ts.net`) or `*.local` — and `https://` is required for anything on the internet (a Cloudflare Tunnel or ngrok URL works). Models on your own hardware are given the model's own timeout instead of the quick 9 s first-word deadline used for cloud services. On this laptop CPU a 1.5-billion-parameter model needs seconds to start answering (measured below): a fallback for offline use, not a replacement for a GPU. What to send/ask a friend for a GPU server is in [docs/FREE-OPTIONS.md](docs/FREE-OPTIONS.md#what-i-need-for-a-friends-gpu).

## Start a live interview

1. **Prepare first** (recommended): *Interviews → New interview* — pick or upload the résumé and paste the job description (Candor analyses both when you save), then open *Prepare* and press *Generate all*. Prepared answers become instant cache hits during the live session.
2. Open **Live interview**, choose the interview, and check the readiness list (model, speech engine, microphone) and the **What is answering** card. Opening this screen loads the speech model in the background (10–15 s the first time).
3. Choose where the interviewer's voice comes from:
   - **Computer audio (video call)** (default): the sound your PC plays, captured with WASAPI loopback. Your own microphone is not sent anywhere unless you also enable *Transcribe my voice*.
   - **This microphone (in person)**: one microphone hears everyone (use speakers, or accept that both voices are transcribed). Speaker tags (*Settings → Speech recognition → Label speakers*, Deepgram only) are hints, not identity.
4. Read and accept the **audio & privacy notice**. Nothing is captured before you press **Start listening**, and *Pause* (or the hotkey) stops audio reaching the speech engine immediately. With the default on-device engine, audio never leaves the PC.
5. During the interview the question appears in the centre and the answer streams on the right, usually starting **before** the interviewer has finished speaking (*speculative generation*; restarts automatically if the question changes). You can also type a question into the bar at the bottom.
6. Steer with the mode buttons (`Alt+1`…`Alt+7`) or the global hotkeys; press **Add my experience** to weave in something true that Candor did not know; **Predict follow-ups** to see what is likely next.
7. *End session* saves the transcript, answers and timings to *History* (unless you turned that off in *Settings → Privacy*).

Type-only mode (no audio at all) is the same screen with *Listen with speech recognition* switched off (the button then reads *Start (type questions)*).

### Keyboard shortcuts

In-window (Live screen): `Alt+1` Concise · `Alt+2` Standard · `Alt+3` Detailed · `Alt+4` Bullets · `Alt+5` STAR · `Alt+6` Technical · `Alt+7` Follow-up.

Global (work while another window has focus; change them in *Settings → Hotkeys*, which also shows whether Windows accepted each one):

| Action | Default |
|---|---|
| Pause / resume listening | `Ctrl+Shift+Space` |
| Answer current question | `Ctrl+Shift+A` |
| Shorter · Expand | `Ctrl+Shift+S` · `Ctrl+Shift+E` |
| Convert to STAR | `Ctrl+Shift+T` |
| Regenerate | `Ctrl+Shift+R` |
| Copy answer | `Ctrl+Shift+C` |
| Cycle answer mode | `Ctrl+Shift+M` |

## How the low-latency pipeline works

```
mic / system audio ──► 16 kHz PCM frames (AudioWorklet) ──► main process
                                                              │
                     local energy VAD (adaptive noise floor) ─┤  speech start / end in < 1 ms
                                                              ▼
   streaming speech recognition: on-device worker thread (cloud opt-in), partial + final text
                                                              ▼
       question detector ── stable for ~450 ms and confident?  ──► START DRAFT (speculative)
                                                              │      │
                    text changed materially? ──► cancel + restart    │  retrieval (local BM25 + hashed
                                                              │      │  embeddings + coverage), cached prompt
                    endpoint / confirmation ──► CONFIRM draft       ▼
                                                        LLM stream ──► first token painted immediately,
                                                                      rest coalesced per animation frame
```

The parts that matter, in order of impact: (1) **speculation** — the answer starts before the question ends; (2) **streaming** everywhere, with the first token painted the moment it arrives; (3) a **prefix-cache-friendly prompt** (static profile first) plus a connection **pre-warm**; (4) a small, **tight token budget** per mode; (5) local retrieval and detection that cost well under a millisecond. Every request carries an id, so a stale or cancelled generation can never overwrite a newer one. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Measured performance

Measured on the development PC (Windows 11, Node 24.19, `npm run bench`, 2026-09-21). These are the **local** stages only — no network and no model:

| Stage | p50 | p95 | p99 |
|---|---|---|---|
| Voice-activity detection, per 20 ms frame | 0.002 ms | 0.008 ms | 0.011 ms |
| Question detection, per transcript update | 0.024 ms | 0.042 ms | 0.071 ms |
| Retrieval, 18-chunk profile | 0.20 ms | 0.41 ms | 1.0 ms |
| Retrieval, 416-chunk synthetic profile | 2.4 ms | 3.9 ms | 7.3 ms |
| Prompt assembly | 0.005 ms | 0.010 ms | 0.020 ms |
| Google sign-in (ADC): authorization headers per request, token cached | 0.017 ms | 0.029 ms | 0.077 ms |
| Engine: question in → model request out → first token (instant model) | 0.42 ms | 0.72 ms | 1.3 ms |

Packaged app (eight launches on the same PC, fresh profile): interactive UI 2.0–2.6 s after the process starts (including Chromium's own start-up); main-process window-ready 0.8–1.8 s over the five launches where it was recorded (the slowest was the first start after installing); and 365–378 MB at the idle first-run screen measured as the sum of every Electron process's working set (shared pages are counted once per process, so this overstates the unique memory). Installed size ≈ 590 MB (the speech models are 231 MB of it); installer 295.1 MB (295,120,114 bytes).

**On-device speech recognition** (`npm run bench:stt`: real worker thread, real models, audio paced in real time in 40 ms frames; the same PC, other applications open; details, method and limits in [docs/SPEECH.md](docs/SPEECH.md)):

| | Light model | Accurate model (default here) |
|---|---|---|
| First words appear (from the start of the audio; median / p95) | 844 / 887 ms | 849 / 1031 ms |
| End of speech → final transcript (300 ms silence wait + flush; median / p95) | 453 / 518 ms | 571 / 667 ms |
| CPU while listening (share of one core; median / max) | 23 % / 27 % | 52 % / 66 % |
| Model load (once) / process memory afterwards | 9.1 s / 216 MB | 15.4 s / 339 MB |
| Word error rate: synthetic voices / real read speech | 8.3 % / 0 % | 3.8 % / 0 % |

Words appear roughly 0.4–0.5 s after they are spoken, and the finished transcript is ready about half a second after the interviewer stops. The "first words" row includes the lead-in silence of each clip. Accuracy on noisy, telephone-band, quiet and echoing audio is in [docs/SPEECH.md](docs/SPEECH.md#robustness-damaged-audio); real meeting audio was not available, so treat these as best-case figures.

**A real local language model** (`npm run test:local-llm`: llama.cpp + Qwen2.5-1.5B-Instruct Q4, this CPU, Candor's own retrieval and prompt, typed questions): with the model on this laptop CPU the first word took **12–23 s** per question once warm (45 s for the very first, which queued behind the prompt pre-warm), it then streamed at **about 4 tokens a second**, and a 80–105-word answer finished in **48–72 s** (raw server: reads 14–22 prompt tokens/s, generates 3.6–4.0 tokens/s; the Vulkan build crashed on this Radeon driver). It works, streams and fails gracefully, but it is **too slow for live interviews on this PC** — a GPU (a friend's, or a hosted model) is needed for that; fine for preparation. **“About me” on the same model** (`tests/local-llm/about-real.test.ts`, run alone; nothing else on the CPU): **196–207 s, one model request**, native JSON-schema output, 523–526 tokens, all six fields, whether the model row's token ceiling is 300 or 700 (before the structured-reply fix a 300 ceiling failed with “unusable reply twice (unterminated JSON object)” after 263 s and two requests). Reading a reply costs 8 µs when it is valid JSON and 80–155 µs when it has to be unwrapped, repaired or salvaged. Measuring while other programs run made the same request take 555 s, so these numbers were taken with the CPU otherwise idle. Full table: [docs/FREE-OPTIONS.md](docs/FREE-OPTIONS.md#a-real-local-model-on-this-pc-measured).

**What is not in these numbers** — and dominates real latency — is the speech provider's endpointing delay (if you chose a cloud engine) and the language model's time to first token. Those depend on your provider, region, hardware and model. Measure them for real with **Settings → Performance → Run benchmark**, which sends real requests through the same path a live question takes and reports the median, p90 and p95 of time-to-first-token and total time (the first, cold request is excluded and labelled). During a live session the status bar shows the same measurements for each answer, and *Settings → Performance → Show the performance panel* adds a Perf button to the Live screen with the whole timeline (speech end → final transcript → detection → retrieval → request → first token → paint).

## Testing

```bash
npm test                                  # unit + integration (scripted stand-in for the native speech library)
npm run test:speech                       # the REAL speech engine on real audio (needs npm run models)
npm run test:local-llm                    # a REAL llama.cpp server (needs npm run llm:fetch first)
npx playwright test                       # end-to-end (run "npm run build" first, or use npm run test:e2e)
npx playwright test tests/e2e/packaged.spec.ts   # packaged exe (needs npm run dist:dir); CANDOR_EXE=<path> tests an installed copy
npm run bench                             # local pipeline overhead → test-results/bench-local.json
npm run bench:stt                         # speech latency / CPU / memory / accuracy → bench-results/stt-local.json
npm run bench:robustness                  # speech accuracy on damaged audio → bench-results/stt-robustness.json
```

The end-to-end tests start Electron with Chromium's fake-device flags (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`) so the microphone path runs without hardware or prompts; the on-device speech test also plays a recording into the fake microphone (`--use-file-for-fake-audio-capture`), and the cloud-speech tests point Deepgram at a local mock server with `CANDOR_DEEPGRAM_URL`. `CANDOR_USER_DATA` isolates each run's database. Screenshots are written to `test-results/screens`.

## Packaging

`npm run dist` (which first runs `npm run models:verify`) produces `release/Candor-Setup-<version>.exe` (295 MB, 295,120,114 bytes; per-user install, no administrator rights, choose-folder page, Start-menu and desktop shortcuts). It includes the on-device speech models (231 MB) so speech recognition works offline immediately. Uninstalling keeps your data unless you delete it first in *Settings → Privacy*.

* The executable is hardened with Electron fuses (no `RunAsNode`, no `NODE_OPTIONS`, no `--inspect`, code loaded only from the integrity-checked asar) — see [`electron-builder.yml`](electron-builder.yml). The speech worker script and the prebuilt speech library are unpacked beside the archive (a thread and a native DLL cannot be loaded from inside it) and the models live in `resources\models`.
* **The installer is not code-signed**, so Windows SmartScreen will show an “unknown publisher” warning. To sign, provide a code-signing certificate through electron-builder's standard environment variables (`CSC_LINK`, `CSC_KEY_PASSWORD`); signing was not exercised here.
* There is no auto-update; install the new version over the old one.
* The app icon is generated by `node scripts/make-icon.mjs`.
* **Upgrading from an older build:** settings are saved as one object, so an older installation still has the old cloud speech default written in it. On first start Candor switches such an installation to the free on-device engine **once**, but only if the selected cloud speech service has no key (a cloud service you added a key for is left alone). It never moves anyone *to* a cloud service. Tested on a copy of the installed app's real database.
* Only Windows is built and tested. To upgrade an installed copy, close Candor and run the new installer; your data in `%APPDATA%\Candor` is kept. macOS and Linux code paths exist (platform-specific calls are isolated in `src/main/electron/platform.ts`) but were never built or run.

## Data, privacy and security

* Everything is stored locally in `%APPDATA%\Candor` (SQLite database, encrypted keys, logs). There is no telemetry, no account and no auto-update.
* Data leaves the PC only through the calls you configure: **audio goes nowhere by default** (speech recognition is on-device; only a cloud speech engine you choose receives it, while listening), and the current question plus a small set of retrieved facts go to your model provider — which may be on this PC. See [docs/PRIVACY.md](docs/PRIVACY.md) for the exact inventory.
* The renderer is sandboxed with no Node access and a strict CSP; all network access, keys and files live in the main process behind schema-validated IPC. See [docs/SECURITY.md](docs/SECURITY.md) for the threat model, the review, what was fixed, and residual risks.

## Troubleshooting

| Symptom | Fix |
|---|---|
| “That looks like a Google key, but this provider is OpenAI” | You picked the wrong service for the key. Candor stops before sending it anywhere; choose the matching service (the setup guide no longer pre-selects one). |
| “Google's free tier gives ‘model’ no quota” / “out of quota or credit” | Google lists many models, but not every model has free quota on every project. Pick a *Flash* or *Flash-Lite* model in **Settings → Models** (or press *Save & test* in Quick setup, which tries the other suitable models and tells you which one worked). |
| “API keys are disallowed” | Your organisation forbids API keys. Use Google sign-in: [docs/GOOGLE-ADC.md](docs/GOOGLE-ADC.md). |
| “No AI model is set up” | Add a provider and models (Settings → AI Providers, Models) or use the offline features only. |
| Live screen says the speech model is missing or damaged | Reinstall Candor (the models ship inside it), or from the source folder run `npm run models`. Typed questions work without speech. |
| “The speech engine could not start on this PC” | Security software may have blocked the bundled speech library (`sherpa-onnx.node`). Allow Candor in it, or pick a cloud engine in *Settings → Speech recognition*. |
| “Speech recognition is running about N s behind” | The PC is busy: close heavy applications, or choose the **Light** model in *Settings → Speech recognition*. |
| Words are wrong on names or jargon | Expected at times (see [docs/SPEECH.md](docs/SPEECH.md)); the language model reads the question against your résumé and role. The **Accurate** model is better than **Light**. |
| “Could not connect to X on this PC” / “on your network” | The model server is not running or not reachable: start Ollama / LM Studio / `llama-server`, or check the friend's machine, address, port and network/VPN. Candor does not switch to another provider on its own. |
| A local model answers very slowly | A laptop CPU reads the prompt slowly. Use a smaller model, or a friend's GPU, or a cloud service; *Settings → Models* lets you raise the timeout. |
| Microphone level stays flat | Windows *Settings → Privacy & security → Microphone* must allow desktop apps; pick the right device in *Settings → Audio*. If Windows denies access, the Live screen shows an *Open Windows settings* button. |
| No sound from *Computer audio* | Loopback captures what Windows plays to the default output. Meeting apps that take exclusive control of the device can defeat it; switch to *This microphone*. |
| A global hotkey does nothing | Another app owns it. *Settings → Hotkeys* shows which shortcuts registered; pick another. |
| Answers arrive slowly | Check the status bar: high *first-word* time is speech recognition or endpointing (lower *Settings → Speech recognition → End-of-speech wait*); high *TTFT* is the model — choose a faster live model. Turn speculation on (*Settings → General*). |
| Windows warns about an unknown publisher | The installer is unsigned. Verify where you got it, then choose *More info → Run anyway*. |
| “Could not generate ‘about’” / a section says it is an *offline draft* | The model's reply was cut off or was not usable data. Candor has already asked a second time in a shorter form; the message says which. Press *Try again* / *Regenerate*, or choose a model with more room in *Settings → Models*. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §3.5.1. |
| A model answers in the wrong format and you want to see exactly what it sent | Start Candor with the environment variable `CANDOR_DEBUG_AI=1` (PowerShell: `$env:CANDOR_DEBUG_AI=1; & "C:\Program Files\Candor\Candor.exe"`). Raw replies are then written to `%APPDATA%\Candor\logs\ai-debug.jsonl` on this PC only, with credentials masked; add `=full` to include prompts (they contain your résumé). Delete the file afterwards. |
| Something failed | Logs are in `%APPDATA%\Candor\logs\candor.log`: which model answered, how it finished, HTTP status and error class per failed request (keys, prompts, replies and transcripts are never written there). |

## Known limitations

* **Not verified against live services** — see the status table. That includes Google sign-in (ADC): it is tested against Google's real auth library and local stand-ins for Google's servers, not against a real Google account.
* **On-device speech accuracy was measured on synthetic voices, real read speech and simulated damage — not on real interviews.** Names and technical terms are the weak spot, video-call quality audio is worse than clean audio, and a single microphone cannot separate two voices. The on-device models cover English (the accurate one also Chinese). Loading the model takes 10–15 s the first time. See [docs/SPEECH.md](docs/SPEECH.md).
* A language model on this PC's CPU is slow to start (seconds) and much weaker than a large hosted model.
* Not built: custom-vocabulary biasing of the speech decoder (so a name from your résumé is not favoured by the recogniser — the language model corrects it afterwards, and the answer prompt tells it the question may be mis-heard), and automatic stepping down from the accurate to the light model while listening (Candor warns when recognition falls behind and you can switch in *Settings → Speech recognition*).
* Voice-activity detection is an adaptive **energy** detector, not a neural one; a very noisy room reduces its precision (speech recognition still decides the words).
* One microphone cannot reliably separate two voices; diarization tags are optional hints and Deepgram-only (cloud).
* Retrieval uses local keyword + hashed-embedding ranking. It is fast and private but is not a neural semantic search; unusual paraphrases can score lower than they deserve. Cloud embeddings and web research are **not implemented**: the *Company* section is built only from your notes and the job description, and lists what to research yourself.
* There is **no OCR**: scanned or image-only PDFs are rejected with a clear message (paste the text instead).
* The data at rest (résumés, transcripts) is protected by your Windows account and disk encryption, not by an application password; only API keys are encrypted by the app.
* Windows only; unsigned installer; no auto-update; the installer is large (295 MB) because it carries the speech models.
* The main UI bundle is ~700 kB (loaded from disk, not a network cost).

## Project layout

```
src/shared/      types, settings, IPC contract, pure utilities (used by every process)
src/core/        pure logic with no Electron / Node dependence: question detector, retrieval,
                 live engine, VAD, résumé & JD parsing, grounding, evaluation metrics
src/prompts/     system prompts, answer formats and analysis schemas (versioned); the few one-line
                 instructions that wrap per-request data are assembled beside the code that uses them
src/main/        Electron main process: AI gateway + providers, speech (on-device worker + cloud
                 providers), SQLite, document extraction, services, validated IPC, window / hotkeys
resources/       the on-device speech models and self-test sample (npm run models; git-ignored)
scripts/         model fetch/verify, icon and speech-fixture generators
src/preload/     the typed bridge exposed to the renderer (invoke / on / sendAudio)
src/renderer/    React UI, audio capture (AudioWorklet), stores, styles
tests/           unit, integration (real local servers), speech (real engine), local-llm (real server),
                 e2e (real Electron), bench
```

## Why Electron and not Tauri

A Rust/Tauri build was the preferred choice, but it needs the Rust toolchain plus the MSVC/Windows SDK build tools, which are not installed on the machine this was built on (multi-gigabyte, administrator-level installs) — and code that cannot be compiled and tested here would not be honest to ship. Electron gave a fully testable Windows app immediately. The trade-off is size (~590 MB installed, ~295 MB installer, most of it the speech models) and memory. All operating-system-specific code sits behind one `PlatformBridge` interface and the core logic is framework-free, so a Tauri shell could reuse `src/core` and the React UI.

## Licence

Private / unlicensed (see `package.json`). Bundled third-party components keep their own licences — Electron, Chromium, React, `ws`, `unpdf`, `fflate`, `zod`, `google-auth-library`, fonts from Fontsource, and the on-device speech runtime and models (sherpa-onnx, ONNX Runtime, X-ASR, icefall Zipformer). See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
