# Privacy

Candor is local-first. It has **no account, no telemetry, no analytics and no auto-update**, and it does not use your data to train anything. Data leaves your PC only through the services you configure, and only for the reasons listed here. The same inventory is shown inside the app at *Settings → Privacy*.

## What is stored on your PC

Everything is in `%APPDATA%\Candor` (or the folder set by `CANDOR_USER_DATA`).

| Data | Stored as | Notes |
|---|---|---|
| Résumés (extracted text and structured facts), job descriptions, interview details, notes, stories, saved preparation | SQLite database (`candor.db`) | Not encrypted by the app; protected by your Windows account and, if enabled, BitLocker. |
| Interview history: transcripts, suggested answers, timings, feedback tags | SQLite | Each can be switched off: *Settings → Privacy → Save transcripts / Save answers*. When off, nothing is written. |
| API keys (models and speech) | Encrypted with Windows DPAPI in the database | Only a hint such as `…7890` is ever shown. Keys supplied through environment variables are held in memory only. |
| Settings | SQLite | |
| Logs | `logs\candor.log` (rotated at ~1 MB) | Short event messages and sizes (which model answered, how it finished, how many tokens); keys, prompts, replies, transcripts and audio are never written. |
| AI debug capture | `logs\ai-debug.jsonl` (only if you start Candor with `CANDOR_DEBUG_AI=1`; rotated at ~5 MB) | Off by default. When you turn it on for diagnosing a formatting problem, raw model replies are written to this local file (with `=full`, the prompts too, which contain your résumé and job text) after credentials are masked. It is never sent anywhere. Delete the file when you are done. |
| Live audio | **Never written to disk** | Held in memory only long enough to stream it. |

## What is sent, to whom, and when

| What | To | When | Contents |
|---|---|---|---|
| **Audio** (16 kHz mono) | **Nobody, by default.** Speech recognition runs on this PC. Only if you choose a cloud speech service (Deepgram or AssemblyAI) in *Settings → Speech recognition* is audio sent to it | Only while you are listening — not before *Start listening*, not while paused, not after *End session* | With *Computer audio* selected the audio is **everything your PC plays** (the interviewer, but also any music or other calls), not just one app. Your own microphone is used only if you enable *Transcribe my voice*, or if you chose *This microphone* as the source. The on-device models ship inside the app; nothing is downloaded when you use it. |
| **The question, a compact profile and a few facts** | Your model provider for live answers — a model on this PC, a machine on your own network (a friend's GPU over your LAN or Tailscale), or a service on the internet; the Live screen and *Settings → AI Providers* show which | For each question | Question text; your name, current role, years of experience, a short summary, top skills, education and certifications; the target role and company; up to about six relevant facts and one story from your résumé and stories; the last exchange or last few questions for follow-ups. **Not** the whole résumé or job description. |
| **Résumé and job description text** | Your model provider for preparation | Only when you choose *Use AI* (analysis) or *Generate* (preparation), and only if a model is configured | Résumé up to about 24,000 characters; job description up to about 12,000; company notes; your facts. |
| **Provider queries** | Your provider's API host | *Test* buttons, listing models, the benchmark | Small test prompts; the benchmark sends real (short) requests. |
| **Links you open** | Your default browser | When you click *Get a key* etc. | Only allow-listed provider sites. |

With **Google sign-in (ADC)** the requests go to Google Cloud (Vertex AI, or the Gemini API) under *your* project's terms and billing, authenticated with your Google account; Candor does not store the credential. With a Gemini **API key** on Google's free tier, Google's terms state that prompts and responses may be used to improve its products and may be read by human reviewers (paid use is not used that way, and users in the EEA, UK and Switzerland get the paid-tier data terms). Check Google's current terms before sending a résumé.

Nothing else is sent. There are no crash reports, usage statistics, or update checks. The renderer (the UI) cannot make network requests at all; every request comes from the main process to the hosts above.

Your providers process this data under their own terms and retention policies — review those before use, and consider a local model (Ollama, LM Studio or llama.cpp served from your own PC) if you do not want question text to leave the machine. **Speech recognition runs on this PC by default, so audio does not leave it** unless you choose a cloud speech service. A model on another machine on your own network receives the question text over that network (plain http is accepted only for this PC and private networks such as a LAN or Tailscale; anything on the internet must use https).

## Consent and control

* Before the first time audio is captured, Candor shows a notice explaining the above and asks you to accept. You can **withdraw** it in *Settings → Privacy* (you will be asked again before the next capture).
* Capture starts only when you press **Start listening** on the Live screen, only from the source you chose, and stops when you press **Pause** or **End session**. The main process — not the UI — decides which sources are opened and drops audio while paused.
* System audio uses Windows' loopback capture; Windows may show its screen/audio-capture indicator. Microphone capture uses the normal Windows permission prompt, which you can revoke in *Windows Settings → Privacy & security → Microphone*.
* **Recording or transcribing other people can require their consent** under the law where you or they are, and many interviews and employers prohibit AI assistance during the conversation. Candor does not detect or enforce those rules; following them is your responsibility. Candor has no feature to conceal itself from the other party or from screen sharing.

## Your data, your choice

* **Delete**: history per session or all of it, individual résumés, interviews, stories, or *Delete everything* (*Settings → Privacy*).
* **Export**: *Settings → Privacy → Export my data* writes a JSON file with your data. API keys are never included.
* **Stop saving**: turn off *Save transcripts* and *Save answers*.
* **Uninstall**: the uninstaller leaves `%APPDATA%\Candor` in place so you do not lose data by accident; delete the folder (or use *Delete everything* first) to remove it entirely.
