# Security

This is the security model and the result of the pre-release review. The review was done by the authors against the code and tests; it is **not an independent audit**. Most fixes have a regression test or a lint rule that stops them coming back; where neither exists, the table says so.

## 1. What is being protected

| Asset | Where it lives |
|---|---|
| Provider and speech API keys | Encrypted with Windows DPAPI (`safeStorage`) in the local database; optionally in the process environment (memory only) |
| Résumé, job descriptions, stories, notes, interview history, transcripts | Local SQLite database in `%APPDATA%\Candor` |
| Live audio | In memory only; recognised on this PC by default (never sent anywhere); sent to a speech provider only if a cloud one is chosen; never written to disk |
| The user's control over what is captured | Consent flag, explicit start, pause, and per-source activation |

## 2. Threat model

* **In scope**: a hostile document (résumé or job description pasted from the web), hostile text in a transcript, a hostile or compromised model/provider response, a malformed or oversized file, a compromised renderer (XSS-class bugs in the UI), a local user or process trying to read secrets from logs or IPC, and an attacker who can run the packaged binary with unusual flags or environment.
* **Out of scope**: malware already running as the same Windows user (it can read anything the user can, including DPAPI-protected data), physical access to an unlocked PC, and the security of the third-party services you choose to use.
* **Design principle**: the renderer is untrusted, the main process is the only place with authority, and model output is *display text* — no model output is ever executed, evaluated, rendered as HTML, or used as a file path or URL.

## 3. Controls

| Area | Control | Where |
|---|---|---|
| Renderer isolation | `contextIsolation`, Chromium sandbox, `nodeIntegration` off, `webSecurity` on, `<webview>` blocked, in-app navigation limited to the app origin, new windows denied | `electron/window.ts` |
| Bridge | Only `invoke`, `on` (a fixed list of push channels) and `sendAudio`; no `ipcRenderer`, no Node | `preload/index.ts` |
| IPC | One zod schema per channel (strict objects, closed enums, length caps); a channel without a schema does not compile; the sender's frame URL is checked; `audio:chunk` size and shape are validated | `ipc/validators.ts`, `ipc/dispatch.ts`, `index.ts` |
| CSP (production) | `default-src 'self'`, `script-src 'self'`, `connect-src 'self'` (the renderer cannot reach the network), `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'none'`, `base-uri 'none'` | `electron/window.ts` |
| Renderer output | No `dangerouslySetInnerHTML` / `innerHTML` (enforced by lint); model text is rendered as React text nodes | `eslint.config.mjs` |
| Secrets | DPAPI-encrypted; **no plaintext fallback** when the OS keystore is unavailable; only a hint (`…7890`) ever crosses IPC; keys and known secret values are masked in logs | `security/secrets.ts`, `logging.ts` |
| Logging | Structured, redacting; callers log short events and small metadata only — never prompts, transcripts, audio or bodies. Model calls are logged as provider, host, model, output limit, finish reason, sizes, token counts, timing, HTTP status and error class. Raw replies can be captured only by starting Candor with `CANDOR_DEBUG_AI=1` (or `full` for prompts): local file, every string masked for credentials before it is written, announced in the log | `logging.ts`, `ai/diagnostics.ts`, `ai/gateway.ts` |
| Files | Paths come only from OS open/save dialogs, never from the renderer; size is checked before reading; content type is sniffed, not trusted from the extension; PDF page and text limits; DOCX parts are size-checked from the archive header **before** anything is inflated (decompression-bomb guard) | `electron/platform.ts`, `documents/*` |
| Local protocol | `candor://app/` serves only regular files inside the renderer folder; traversal, encoded traversal, backslashes, drive letters, NUL and malformed encoding are refused | `electron/appPath.ts` |
| External links | https only, host allow-list (provider sites), no credentials in the URL | `security/links.ts` |
| Permissions | Microphone (audio only — the camera is denied) for the app's own origin; system audio only while the UI has armed it; everything else denied | `electron/window.ts` |
| Google sign-in (ADC) | Credentials are found and refreshed by Google's official `google-auth-library`; Candor never reads the credential file, keeps tokens in memory only, never logs them (redaction knows Google token shapes), and attaches a token **only** to `…googleapis.com` addresses (loopback for tests). A base URL that is not a Google address is refused when saved and again when sending. | `ai/googleAuth.ts`, `ai/providers/google.ts`, `shared/google.ts` |
| Key mix-ups | A key that clearly belongs to another service (for example a Google key given to OpenAI) is refused before it is saved or sent; the setup guide no longer pre-selects a service. | `shared/keys.ts`, `ipc/handlers.ts` |
| Provider URLs | https required; plain http only for this PC and private networks (loopback, RFC 1918, link-local, Tailscale's 100.64/10 and `*.ts.net`, `*.local`) — decided from a literal address or reserved name only, so a public-looking name can never pose as a local server; credentials in URLs rejected. The class (this PC / your network / internet) is shown next to every provider. | `shared/net.ts`, `ipc/handlers.ts` |
| On-device speech | Recognition runs in a worker thread that is given only file paths (no keys, no settings, no network); the model files are checked for presence and exact size before the native library sees them and pinned by SHA-256 (`npm run models` verifies, and refuses to package an unverified set); the native library is the official `sherpa-onnx-node` package (Apache-2.0, maintained by the k2-fsa project, no install scripts) with its prebuilt DLLs; the worker cannot be reached from the renderer | `stt/local/*`, `scripts/fetch-models.mjs` |
| No silent provider switch | A fallback speech or language model is used only if the user configured it (and, for cloud speech, stored its key); a notice is shown when it takes over; nothing is added on the user's behalf | `services/live.ts` (`chooseStt`), `ai/gateway.ts` |
| Prompt injection | Untrusted text is placed in tagged data blocks after `defang()` (a `<` that starts a tag becomes `‹`), prompts tell the model that block contents are data, and answers are checked against the candidate's facts | `shared/util.ts`, `core/live/context.ts`, `core/live/grounding.ts` |
| Model output | JSON output is schema-validated (one repair attempt); extracted facts are dropped unless found in the source text | `ai/structured.ts`, `core/prep/groundResume.ts` |
| Packaged binary | Electron fuses: `RunAsNode` off, `NODE_OPTIONS` off, `--inspect` off, load code only from the asar, asar integrity validation on | `electron-builder.yml` |
| Consent and activation | The main process refuses to start audio without an accepted notice; nothing is captured before *Start*; pause drops frames at the source | `services/live.ts`, `stt/audioSource.ts` |
| Errors | Renderer error boundary; unhandled rejections become visible messages; the main process logs unhandled rejections and exceptions (redacted) | `main.tsx`, `index.ts` |
| Dependencies | Six direct runtime dependencies (`ws`, `unpdf`, `fflate`, `zod`, `google-auth-library`, `sherpa-onnx-node`); `npm audit --omit=dev` reported 0 known vulnerabilities on 2026-09-21 | `package.json` |

## 4. What Candor deliberately does not do

* It does not hide from screen sharing or screen capture (no content-protection or capture-exclusion APIs), does not hide from the taskbar, and does not click through. *Keep on top* is an ordinary visible always-on-top window.
* It does not read or modify other applications, does not inject into or automate any meeting software, and does not install keyboard or mouse hooks. The global hotkeys are ordinary registered shortcuts.
* It does not bypass authentication, disable security software, or collect credentials. It contains no telemetry and no auto-update channel.

## 5. Findings from the review, and what was done

| # | Finding | Severity | Resolution |
|---|---|---|---|
| 1 | Untrusted text (job description, résumé, company notes, transcript) was placed inside XML-style prompt blocks without neutralising closing tags, so a hostile document could try to close a block and add instructions. | Medium (answer manipulation; output is display-only) | `defang()` applied at every prompt-assembly site; unit tests with hostile documents. Prompts also instruct the model to treat block contents as data. |
| 2 | Links opened through `window.open` went to the system browser for any https URL, bypassing the allow-list used by the explicit *open link* channel. The allow-list was also a regular expression. | Low | One shared hostname-based check for both paths; tests for look-alike hosts, embedded credentials and other schemes. |
| 3 | The permission handler granted any `media` request from the app origin, including the camera. The app never uses video. | Low | Requests that include video are denied. No dedicated test; the end-to-end suite exercises the microphone and system-audio paths and would fail if audio were refused. |
| 4 | The `candor://` file handler could throw on malformed percent-encoding and would answer for directories and Windows device names. | Low | Path resolution moved to a pure function with a traversal test-suite; only regular files are served. |
| 5 | Electron 44's `clipboard.writeText` returns a promise; a failure would have been an unhandled rejection. Several UI handlers had no error path. | Low | Awaited and handled; `guarded()` wrapper for UI handlers; a global *unhandledrejection* safety net; `no-floating-promises` / `no-misused-promises` enforced by lint. |
| 6 | A React hook was called conditionally (`useApp` inside `||`), which can crash the résumé dialogs when settings change. Found by the hooks lint rule. | Reliability | Fixed. |
| 7 | On macOS the `activate` event re-ran the whole start-up, registering IPC handlers twice. | Reliability (macOS only) | Window creation split from start-up. Not testable on Windows. |
| 8 | A WebSocket text frame was converted with `toString()` regardless of its type; provider stream events were assumed to be objects. | Low | `rawToString()` for frames; non-object stream payloads are reported as malformed. |
| 9 | The packaged executable could be reused as a Node runtime or started with an inspector by anyone able to set flags or environment variables. | Low | Fuses flipped (see §3); an automated test reads the fuse state of the built executable and the packaged app is launched in the end-to-end suite. |
| 10 | Invisible and control characters were embedded literally in source regular expressions (hard to review, easy to lose). | Hygiene | Replaced with escapes. |
| 11 | Settings for cloud embeddings existed with no implementation behind them. | Honesty | Removed rather than shipped as a control that does nothing. |
| 12 | A DOCX is a zip file, and its XML parts were inflated with no limit on their uncompressed size, so a small crafted file could exhaust memory (decompression bomb). | Medium (denial of service on a file the user chooses to open) | Declared sizes are checked before inflating (20 MB per part, 40 MB in total); a real bomb in the test-suite is rejected in milliseconds. |
| 13 | A Google API key pasted while the wrong service (OpenAI) was selected was sent to that service, because the setup guide pre-selected OpenAI and nothing compared the key with the service. | Medium (a credential disclosed to a third party) | Key-format check before saving and sending (Google, Anthropic, OpenAI, Groq, OpenRouter prefixes), no pre-selected service, and a warning in the form; tests reproduce the exact mix-up. If this happened to you, delete that key in the provider's console and create a new one. |

Verified with no change needed: schema coverage of every IPC channel, sender checks, no raw HTML rendering, keys never returned over IPC, key redaction in logs, file paths never taken from the renderer, size checks before reading files, and the export excluding secrets.

## 6. Residual risks

* **Data at rest is not encrypted by the application.** The database (résumés, transcripts, answers) relies on your Windows account and disk encryption (BitLocker). Only API keys are encrypted by the app. Use *Settings → Privacy* to stop saving transcripts and answers, or to delete data.
* **DPAPI protects against other users and offline copies, not against malware running as you.**
* **Prompt injection cannot be fully prevented.** Because model output is only displayed, the worst case is a misleading answer. The grounding check flags numbers and names that are not in your facts, but you remain responsible for what you say.
* **Third parties see your data**: with the default on-device engine nobody hears the audio; if you choose a cloud speech service it does. The model provider receives the question, a compact profile and a few retrieved facts (and, for preparation, your résumé and job description). Choose providers whose terms you accept, or use a local model. See [PRIVACY.md](PRIVACY.md).
* **The speech models are third-party files** (about 230 MB) fetched from their publishers' official locations and pinned by SHA-256; a model is executable *data* for the native inference library, so a malicious model file could in principle exploit a bug in it. Only the hash-pinned files are accepted by `npm run models`; do not drop unverified model files into `%APPDATA%\Candor\models\stt`.
* **Plain http to a private network is unencrypted.** On a shared or untrusted LAN, prefer Tailscale or an https tunnel for a friend's server, and give the server an API key.
* **PDF parsing is delegated to pdf.js (`unpdf`)** under page-count, text-length and file-size limits; a maliciously crafted PDF could still consume noticeable CPU or memory within those limits. Only open documents you trust.
* **CSP allows inline styles** (`style-src 'unsafe-inline'`), needed for React's style attributes. Scripts remain restricted to the app's own files.
* **Chromium's `--remote-debugging-port` is honoured**, as for any Electron app. Someone able to launch the app with arguments can already read the user's data directly.
* **The installer is unsigned**, so its origin cannot be verified by Windows. Sign release builds with a code-signing certificate.
* **Supply chain**: the runtime dependency set is small, but the build depends on the npm ecosystem; pin and audit before releases.
* **Only Windows was built and tested.**

## 7. Reporting

Report suspected vulnerabilities privately to the maintainer rather than in a public issue, including the version (*Settings → Storage* shows it) and reproduction steps. Do not include real API keys or personal documents.
