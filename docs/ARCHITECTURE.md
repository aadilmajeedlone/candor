# Architecture

This document explains how Candor is put together and, in particular, why the live path is fast. For setup and usage see the [README](../README.md); for the threat model see [SECURITY.md](SECURITY.md).

## 1. Priorities

When goals conflict, the order is: **live response speed → accuracy and personalisation → streaming → audio/STT reliability → a simple, fast UI → résumé/JD understanding → follow-ups → mock interviews → history and story bank → cosmetics.** Two rules sit above the list: never invent facts about the candidate, and never report a latency number that was not measured.

## 2. Process model and trust boundaries

```
┌────────────────────────── renderer (sandboxed, no Node) ───────────────────────────┐
│ React UI · zustand stores · AudioWorklet capture (16 kHz PCM16, 40 ms frames)       │
│ window.api = { invoke, on, sendAudio }   ← the only thing preload exposes           │
└───────────────▲──────────────────────────────────────────────┬──────────────────────┘
      push events│(live.event, gen.event, …)        invoke(channel, payload) │ audio:chunk
                 │                                              │ (zod-validated, sender-checked)
┌────────────────┴──────────────────────────────────────────────▼──────────────────────┐
│ main process                                                                           │
│  ipc/dispatch → handlers → services (live, prep, mock, analysis, bench)               │
│  core/  (pure logic: engine, detector, retrieval, VAD, parsing, grounding)             │
│  ai/    gateway + OpenAI-compatible / Anthropic / Gemini adapters (HTTP via net.fetch) │
│  stt/   on-device engine (worker thread), Deepgram + AssemblyAI, ResilientStt          │
│  db/    node:sqlite (WAL, FTS5, versioned migrations)   security/  DPAPI secret store  │
│  electron/ window, permissions, candor:// protocol, global hotkeys, platform bridge    │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

* **Everything with authority lives in the main process**: network, API keys, files, the database, audio-source decisions. The renderer is treated as untrusted: it has `contextIsolation`, the Chromium sandbox, no Node, a production CSP with `connect-src 'self'`, and can only call whitelisted, schema-validated channels.
* `src/core` and `src/shared` have no dependency on Electron or Node APIs, so the whole decision logic runs in plain vitest with a fake clock.
* **Dependency injection at the seams** makes the same code testable and portable: `fetch` (Electron's `net.fetch` in the app, Node's in tests), the clock, the OS secret cipher, the WebSocket endpoints, and a `PlatformBridge` (dialogs, clipboard, notifications, hotkeys, memory) that tests replace with a stub.

## 3. The live pipeline

```
 audio frame ─► EnergyVad ─► AudioSource ─► ResilientStt ─► LiveEngine ─► LlmGateway ─► provider
    (renderer)   (main)     (pause gate)   (on-device worker      (state)       (stream)
                                            or WebSocket)
                                                              │  ▲
                            detector · cache · retrieval ◄────┘  └── events (transcript, question,
                            prompt builder · grounding check          answer-token, answer-done, …)
                                                                        │
                                                            renderer store ─► rAF-coalesced paint
```

### 3.1 Audio and VAD

* The renderer captures with an `AudioWorklet` (not `ScriptProcessor`) and posts 16 kHz mono PCM16 frames to the main process. The worklet file is a real asset so it loads under the strict CSP.
* **What is captured is decided in the main process**, from its own settings: `live.start { interviewId, audio }` plans the sources (system audio as *interviewer*, optionally the microphone as *candidate*; or one microphone as *unknown* speaker). Nothing is captured without the consent flag, and `AudioSource` drops frames while the session is paused or stopped.
* System audio is Chromium's `getDisplayMedia` with WASAPI loopback, granted by the session's display-media handler **only while the UI has armed it** (`audio.arm`); the video track is discarded immediately.
* `EnergyVad` works on 20 ms frames: an adaptive noise floor, an onset run and a hangover run per sensitivity profile. It costs a few microseconds per frame (see the benchmark) and provides two things the recogniser cannot: instant *speech start / end* events, and a **flush request** to the speech engine the moment the speaker stops instead of waiting for its own endpointing timer.

### 3.2 Speech recognition

Speech recognition is **on this PC by default**, behind one provider interface. `SttProvider` has three implementations: `local` (the default: an on-device streaming model, free, offline, no key), and `deepgram` / `assemblyai` (cloud services over WebSocket, opt-in, each needing its own key). `ResilientStt` wraps whichever is chosen:

* reconnects with backoff on transient failures and **replays a short ring buffer of audio** after a reconnect so words are not lost;
* treats "cannot ever work" failures (a rejected key, a missing model, a blocked native library) as fatal and everything else as transient;
* on a fatal or repeated failure switches to the configured fallback provider and emits a visible notice. `LiveService.chooseStt` never uses a provider that is not set up: a cloud service needs its key, the on-device engine needs its model files; if the configured provider cannot be opened but the configured fallback can, the fallback is used and the user is told.

**The on-device engine** (`src/main/stt/local`; measurements and the model choice are in [SPEECH.md](SPEECH.md)):

```
 AudioWorklet ── audio:chunk ──► AudioSource ──► ResilientStt ──► LocalSttHost ═══ postMessage ═══► worker thread
 (renderer, 16 kHz PCM16)        VAD + pause gate   reconnect,      status · lag · idle unload        sttWorker.js
                                                    replay          ◄═ partial / final results ═══    RecognizerCore
                                                                                                      sherpa-onnx streaming
                                                                                                      transducer (int8)
```

* **Off the main thread.** Decoding takes tens of milliseconds per chunk of pure computation; in a `worker_threads` worker (a second rollup entry, `out/main/sttWorker.js`, unpacked from the asar in the installed app) it can never delay IPC, timers or the answer stream. PCM frames are transferred, not copied.
* **Incremental.** Frames go in as they arrive (40 ms). Whenever the model has a full chunk it decodes it; a changed running text is reported at once as a *partial* result, so the question detector can start understanding while the interviewer is still talking. Nothing is re-decoded from the start of the utterance.
* **Fast end of speech.** On the VAD's *speech end* the pipeline calls `finalize()`: the worker pads 400 ms of silence so the model's right-hand context is complete, decodes the remainder and emits a *final* result flagged `speechFinal`. The recogniser's own endpoint rule (0.6–2 s of silence) is only the backstop.
* **One model, loaded once.** The model loads when first needed (opening the Live screen or *Test speech recognition* warms it), is shared by every stream (microphone and computer audio), kept between sessions, and released after ten idle minutes. One decoding thread was measured best: extra threads spin-wait and burn a whole core for no latency gain.
* **Text shaping** (`format.ts`): the light model writes ALL CAPS without punctuation, so results are sentence-cased and the pronoun "I" fixed; a *final* result gets a full stop or question mark unless it stops on a word no sentence can end on (“…a time when”), which means the speaker paused mid-question.
* **Failure modes are named.** Model missing or incomplete (sizes are checked before the native library sees the files) and a blocked native library are fatal and say what to do; a load that never finishes times out; a worker that dies is restarted with the audio replayed, and three deaths in a minute become a clear failure instead of a loop; audio that is processed slower than it arrives raises a visible “running behind” notice.
* **Two bundled models** (accurate and light), chosen automatically from the PC's cores and memory, or by the user. Both are pinned by SHA-256 in `catalog.json`; `npm run models` fetches and verifies them.

The cloud providers speak their streaming protocols (Deepgram `Results` with `is_final` / `speech_final`, AssemblyAI v3 `Turn`), send keep-alives and batch audio to what each accepts (AssemblyAI needs ≥ 50 ms messages).

### 3.3 The engine (`src/core/live/engine.ts`)

The engine turns a stream of transcript fragments into *turns* and decides when to spend a model call.

| Concept | Behaviour |
|---|---|
| **Question detection** | `detectQuestion` scores each partial transcript (interrogative openers, imperative prompts such as “tell me about…”, complete-phrase bonus, statements and small talk penalised) and returns kind (behavioural, technical, HR, leadership, follow-up…) plus a confidence. It runs in tens of microseconds. |
| **Speculative start** | Once a question is confident (balanced: ≥ 0.75) and its text has been *stable* for a short time (balanced: 450 ms; aggressive: ≥ 0.6 / 260 ms), generation starts **before the interviewer has stopped talking**. |
| **Restart** | If the text later changes materially (`materiallyChanged`), the draft is cancelled and restarted, up to a per-level limit. Cheap edits (punctuation, casing, one extra content word) do not restart; two or more new content words, or a low word overlap, do. |
| **Confirm** | An endpoint from the provider or VAD (or an auto-confirm timer if the speaker went quiet) confirms the draft: no new request is made, the already-streaming answer simply becomes final. |
| **Merge window** | Text that arrives within 1.5 s of an endpoint continues the same question (“…and how did you handle it?”). |
| **Hold-off** | For a configurable time after an answer (default 6 s) weak question-like speech is ignored so the candidate's own reply is not mistaken for a new question. |
| **Follow-ups** | A question that refers back (“why did you choose that?”) is generated in follow-up mode with the last exchange in the prompt and the previous facts carried over. |
| **Request ids** | Every generation carries an id. Tokens, completions and errors from a superseded id are ignored; aborted requests are actually cancelled at the socket. A stale answer can never overwrite a newer one, and a cancelled one can never be saved. |
| **Cache** | `AnswerCache` is semantic (local embedding cosine ≥ 0.85 **and** content-word Jaccard ≥ 0.75, scoped to the interview-context hash and the answer mode). Answers prepared in advance are loaded into it when the session starts, so a predicted question is answered instantly. |
| **Modes** | Seven modes with tight `maxTokens` (150–640), because a shorter generation finishes sooner. Switching mode mid-answer regenerates in the new mode. |

Timeline marks per turn (`speechStart`, `firstPartial`, `speechEnd`, `finalTranscript`, `questionDetected`, `retrievalStart/End`, `llmSend`, `firstToken`, `complete`) feed `TurnLatency`: `firstPartialMs`, `sttFinalMs`, `detectionMs` (detector compute only), `retrievalMs`, `ttftMs`, `totalMs`, `perceivedMs` (speech end → first token, **negative** when speculation beat the end of the question) and `uiFirstPaintMs` (reported back by the renderer). They are shown in the status bar, stored with each answer, and summarised as median / p90 / p95.

### 3.4 Retrieval and the prompt

* On session start `buildInterviewContext` indexes the candidate's facts, stories, notes and role text once (`HybridIndex`): BM25 over a stemmed, synonym-aware vocabulary, a 1024-dimension signed feature-hashing embedding, and a query-term **coverage** score, blended as 0.5 × coverage + 0.3 × embedding cosine + 0.2 × normalised BM25. No network, no model.
* Per question, `retrieveForQuestion` returns the top facts and at most one story (limits depend on the mode), a `retrievalConfidence`, and — for generic questions (“tell me about yourself”, closing questions) where nothing scores highly — a fallback to signature facts so the answer is never context-free.
* `buildAnswerPrompt` **puts the static material first** (`<candidate_profile>`, `<role>`) and everything per-question last, so providers with automatic prefix caching reuse the shared prefix across questions; `warm()` sends the static prefix once at session start (and opens the connection with `session.preconnect`) so the first question does not pay for a cold TCP/TLS handshake and cold cache. The whole résumé and job description are **never** sent per question.
* The system prompts, answer formats, mode rules and analysis schemas live in `src/prompts/index.ts` (versioned, `PROMPT_VERSION`); the few one-line instructions that wrap per-request data (for example “ask question 2 of 5”) are assembled next to the code that uses them. Untrusted text placed in XML-style blocks is passed through `defang()` so it cannot forge or close a block.

### 3.5 The gateway (`src/main/ai`)

* Three adapters (OpenAI-compatible, Anthropic, Gemini) behind one `ProviderAdapter` interface: streaming SSE parser that tolerates chunk boundaries anywhere (including inside a UTF-8 sequence), non-streaming fallback, adaptive parameter quirks (`max_tokens` vs `max_completion_tokens`, models that reject `temperature`, JSON mode), and error mapping to a fixed taxonomy (`auth`, `rate_limit`, `network`, `timeout`, `model_not_found`, `context_overflow`, `malformed`, `server`, `bad_request`, `not_configured`, `aborted`).
* **Routing** by task (live, preparation, classification, mock): each has a primary and a fallback model, with sensible borrowing (live↔prep, classify→live, mock→prep) if a task is unset.
* **Watchdogs** per request: total timeout, **time-to-first-token** and mid-stream **stall** (15 s). For a service on the *internet* the live first-token deadline is 9 s so a flaky endpoint hands over to the fallback quickly; a model on this PC or your own network (`endpointScope`) is given the model's own timeout instead, because a laptop CPU reading a long prompt is slow for honest reasons. A watchdog abort triggers a retry (live: 1, preparation: 2) and then the fallback model, with a visible notice. If any text has already been shown, the gateway does not silently switch models mid-answer. A fallback exists only if the user configured one; nothing is added on their behalf.
* **Google (Gemini)** signs in with either an API key or **Application Default Credentials** (Google's official `google-auth-library`, no key): Vertex AI or the Gemini API endpoint, with the token attached only to Google API hosts, Google-specific error explanations, and a model picker that prefers current, quota-holding text models. See [GOOGLE-ADC.md](GOOGLE-ADC.md).
* **Self-repair of Gemini model picks** (`attemptHealing` in `gateway.ts`): if a Gemini API-key model fails in a way that proves the *model* is at fault (Google's free-tier “limit: 0” reply, “model not found”, or a non-chat model such as computer-use / deep-research refused), the gateway lists the provider's models, probes up to five suitable ones (`geminiCandidates`), saves the first that answers into the same model row (visible in Settings → Models) and retries once, with a notice — on the request's own channel when it has one (Live), otherwise as an app-wide message (`app.notice`), once even when several requests fail together. One repair is shared by parallel requests, a dead end is remembered for ten minutes, and it is limited to the same provider and key.
* **Where a server is** (`src/shared/net.ts`): every provider is classified as *this PC*, *your own network* (RFC 1918, link-local, Tailscale's 100.64/10 and `*.ts.net`, `*.local`) or *the internet*, from its literal address or reserved name only (a public-looking name is always “internet”). The class decides whether an API key is required, whether plain `http` is allowed, how a connection failure is worded (“Ollama is not running” versus “internet unavailable”) and what the interface shows in the “What is answering” card and the Live status bar.
* **Structured (JSON) replies** — see 3.5.1 below. `generateJson` is the one entry point for every reply that must arrive as data.

### 3.5.1 Structured replies: how a reply is asked for, read, and retried

A model that is asked for JSON does not always deliver JSON: fences, a friendly sentence around it, a slipped comma, a missing brace, an empty reply, or a reply that simply stops because it ran out of output space. A failure of the last kind broke Preparation (“The model returned an unusable reply twice (unterminated JSON object)”): the cause was in Candor's own request, not in the provider or the key, and the design below removes it rather than retrying it.

**1. The request** (`gateway.ts` `runOnce`, the three adapters).

* **The budget is the caller's, not the model row's.** A structured request is sized by the code that asks for it (About me: 1800 tokens). The per-model *Max tokens* setting only caps spoken answers; it used to clamp every request, so an About request that fell back to a Fast row with a 700-token cap was cut off mid-string. The sanity ceiling for a structured reply is 8192 tokens.
* **Hidden reasoning is kept small.** Gemini 2.5 and Gemini 3 “think” before they answer, and the thinking tokens are spent from the *same* output limit as the reply. Structured and live requests ask for the smallest amount the model allows (`thinkingBudget: 0` for 2.5 Flash and Flash-Lite, 128 for 2.5 Pro, `thinkingLevel: low` for Gemini 3, `reasoning_effort` for OpenAI reasoning models). A model that refuses a parameter is moved down the list (`thinkingLevel` → `thinkingBudget: 0` → none) and remembered; nothing the model does not accept is sent again.
* **Native structured output where the provider has it.** With a JSON Schema, Gemini gets `responseSchema` (translated to the OpenAPI-style subset it accepts, `src/main/ai/schema.ts`) and OpenAI-compatible servers get `response_format: json_schema`. A server that refuses one is stepped down — schema → `json_object` → plain prompt — and remembered for the session. Anthropic has no JSON mode: it gets the prompt instruction and relies on step 2.
* **Small on purpose.** The four Preparation schemas are flat; About me asks for about 450 words in six fields (it asked for about 700), and has a compact form (about 200 words) for the retry.

**2. Reading the reply** (`src/main/ai/jsonExtract.ts`, pure, never throws).

* Fenced blocks, prose before and after, several objects, braces and quotes inside strings, escaped quotes and unicode are handled by a string-aware scanner (not a “first `{` to last `}`” regex).
* Mechanical repairs change punctuation only: trailing and repeated commas, a missing comma between members, comments, single quotes, unquoted keys, raw line breaks inside strings, an unescaped quote inside a sentence, a bracket left open, Python-style `True`/`None`.
* **A reply that was cut off is salvaged, never completed.** The values that were written in full are kept (`completeKeys`); a string cut in the middle is dropped, a list keeps its finished items, half of a list item is not an item. Nothing is invented. A reply that lacks only its closing brace is therefore complete; two partial replies that between them wrote every required field are combined.
* How the reply *ended* counts as much as what it says: the provider's finish reason (`length` = output limit reached), whether a stream finished at all (a stream that just stops sets `completed: false` and the person is told the answer may be cut off), and whether the model stopped mid-object.

**3. Retrying** (`structured.ts`). At most two model requests in the ordinary failure case, and the second is never the first again:

| First reply | What happens |
|---|---|
| Valid, or repaired locally | Accepted. One request. |
| Cut off, but every required field was written | Accepted from the salvage. One request. |
| Cut off / empty / no JSON / wrong shape | One more request: a shorter format (the caller's compact prompt, or a generic “keep every field short”), a larger budget if the reply was cut off (doubled, up to the ceiling), temperature 0 if it was merely unreadable. The person sees why. |
| Second reply also unusable | Values that either reply wrote in full are combined; if every required field is there, done. |
| Still unusable and the caller allows it | *About me only*: if the salvage already holds the main text there is nothing more to ask; otherwise one plain-text request for the spoken answer. The other fields come from the résumé (`aboutDraft.ts`), never from guesswork, and the page says so. |
| Nothing usable | Preparation saves an **offline draft** (built only from the résumé and job description, as the Role/Company/Questions sections always could) with a visible note and *Regenerate*. It is not an error page. |

Provider problems are not reply problems: a rejected key, a rate limit, a server that is down, or a timeout is reported as exactly that, with *Try again*, and is never disguised as an offline draft. The gateway's own retries (exponential back-off for rate limits, server errors, timeouts and network failures) sit underneath and are not multiplied by the JSON attempts.

**4. A failing model is rested.** Server errors and timeouts count against a model across *all* requests; after two within a minute the model is tried second, not first, for a minute (`gateway.ts` `strike`/`isCooling`). Preparation runs four sections at once, and each used to go through its own three-attempt retry of a failing primary (twelve requests for one pass, more with repairs). Requests that are still retrying now stop and use the fallback.

**5. What is logged** (`candor.log`, always): per reply the provider, host, model, whether it streamed, how structured output and reasoning were asked for, the output limit sent, the finish reason, whether the stream completed, sizes and token counts (including hidden reasoning), timing, the provider's reply id and any parameters that were dropped; per failed request the error class, HTTP status, attempt number and whether it will be retried; per structured reply whether it was accepted or why not. Never keys, prompts or replies. For diagnosing formatting problems, `CANDOR_DEBUG_AI=1` (or `=full`, which adds prompts) appends raw replies to `logs\ai-debug.jsonl`: local only, off unless set, size-capped, with every string masked for credentials before it is written, and announced in the log at startup.

### 3.6 Rendering

The live store paints the **first token immediately**, then coalesces the rest once per animation frame. The renderer reports first-paint time back so the pipeline measurement extends to the pixel.

## 4. Preparation and honesty

* **Résumé/JD ingestion** (`src/main/documents`): file type is sniffed from content, not the extension; PDFs are read with `unpdf` and laid out by a region-based reader that handles two-column résumés; DOCX is read through `fflate` (tables, headers/footers). Size, page and text limits apply; scanned, encrypted or corrupt files produce specific, actionable errors.
* **Two-stage parsing**: an offline heuristic parser always runs; when a model is configured it adds structure. A **grounding gate** (`groundProfile`) then drops any model-extracted role, skill, certification, number or fact that cannot be found in the source text (a role's title and company must appear together, numbers must exist verbatim). What the model returns is therefore never trusted more than what the document says.
* **Answer time**: the prompt rules restrict the model to the supplied facts, story and any `<user_addition>`; `checkGrounding` then compares the finished answer with everything the model was allowed to use (numbers by value *and* kind — “9%” does not support “$9 million” — and capitalised names) and highlights unsupported details in the UI. It cannot prove an answer true, only flag details that appear from nowhere.
* **Confidence**: the retrieval confidence is shown with the answer, along with the facts it used; when nothing relevant exists the answer says so and offers *Add my experience*.

## 5. Persistence

SQLite through the built-in `node:sqlite`, in WAL mode, with versioned migrations and an FTS5 index over history. Tables: `users`, `settings`, `providers`, `model_configs`, `secrets`, `resumes`, `interviews`, `job_descriptions`, `prep_sections`, `stories`, `questions`, `sessions`, `answers`, `transcripts`, `bench_runs`, and the virtual `search_index`. `secrets` holds only DPAPI ciphertext. `data.export` omits secrets; `data.purge` deletes history or everything. Storing transcripts and answers can each be switched off (the engine then does not persist them at all).

## 6. IPC contract

`src/shared/ipc.ts` defines one typed request/response map for every invoke channel (about ninety), plus push channels (`live.event`, `gen.event`, `prep.progress`, `bench.progress`, `hotkey`, `app.notice`, `mock.event`) and the one-way `audio:chunk`. `validators.ts` is typed `Record<RpcChannel, ZodType>`, so a channel without a schema does not compile. `dispatch` validates, then calls the handler; the handler map has no Electron import, which is how the integration tests drive the real handlers.

## 7. Failure handling

| Failure | Behaviour |
|---|---|
| Invalid key / model not found | Clear message with the fix; *Test* buttons reproduce it; no retry storm. |
| Rate limit, 5xx, timeout | Retry once (live) with backoff, then the fallback model; visible notice. |
| Malformed, empty or cut-off reply | Read tolerantly first; if it still cannot be used, one *different* request (shorter, larger budget), then a plain-text last resort for About me, then an offline draft with a note. Never the same request twice (3.5.1). |
| A model failing repeatedly (5xx, timeout) | Rested for a minute across all requests; the fallback goes first. |
| Offline | Offline bar in the UI; preparation falls back to the local parser; typed questions still work with a local model. |
| Speech engine failure | On-device: model missing/incomplete or native library blocked → fatal, plain message, fallback provider only if configured; worker crash → restart with audio replay (three in a minute → fatal); falling behind real time → visible notice. Cloud: reconnect with audio replay, then the fallback provider. The transcript pane shows the state; typing always works. |
| Model server down (Ollama, a friend's GPU) | “Could not connect to X on this PC / on your network…” with what to check; no other provider is tried unless configured. |
| Microphone denied / no device | Specific message, *Open Windows settings*, and typed mode. |
| Bad file | Named cause (scanned, encrypted, too large, empty, unsupported). |
| Crash in the UI | Error boundary with recovery; unhandled rejections become visible messages; the main process logs (redacted) instead of dying. |

## 8. Testing strategy

* **Unit**: the pure logic with fake timers (engine timing, restart and dedupe rules, detector, retrieval ranking, VAD, parsers, grounding, prompt isolation, path and link guards, log redaction).
* **Integration**: real HTTP and WebSocket servers imitate the providers (including chunked SSE, rate limits, bad keys, dropped sockets, malformed frames), and the entire application is driven through the real IPC handlers with a real SQLite file.
* **End-to-end**: Playwright drives the real Electron app (and the packaged exe) with a fake audio device, checking behaviour, layout and hardening, and saving screenshots.
* **Real engines, no mocks**: `npm run test:speech` runs the real speech engine on real audio; `npm run test:local-llm` runs Candor against a real local language-model server (llama.cpp); the packaged-app E2E loads the bundled model inside the installed layout.
* **Benchmarks**: `npm run bench` for local stages; `npm run bench:stt` and `npm run bench:robustness` for the speech engine (real worker thread, real-time audio); the in-app benchmark for the real network path.

## 9. Extending

* **New LLM provider** – implement `ProviderAdapter` (`complete`, `stream`, `listModels`) in `src/main/ai/providers`, register its `kind`, add it to the validator enum and a preset in `ProvidersTab`.
* **New speech provider** – implement `SttProvider` in `src/main/stt`, register it in `createSttRegistry` (`src/main/stt/registry.ts`) and add it to the settings enums.
* **New on-device model** – add its files, sizes and SHA-256 to `src/main/stt/local/catalog.json` and a label to `LOCAL_MODEL_INFO`; any sherpa-onnx streaming *transducer* works with the existing recogniser (`buildRecognizerConfig`). Add a download source to `scripts/fetch-models.mjs`, then measure it with `npm run bench:stt`.
* **Another shell (e.g. Tauri)** – reuse `src/core`, `src/shared`, `src/prompts` and the React UI; re-implement `PlatformBridge`, the secret cipher and the audio-capture bridge.
