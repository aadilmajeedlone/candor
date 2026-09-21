# Speech recognition on this PC

Candor turns the interviewer's voice into text **on your computer**: free, private (audio never leaves the PC), offline, no account or key. This page explains how it works, why these models were chosen, and what was measured. Every number below was produced by a script in this repository on the machine named in each table; none is an estimate.

## The pipeline

```
microphone / computer audio
   │  AudioWorklet (audio thread, renderer)   16 kHz, 16-bit, 40 ms frames
   ▼
IPC ─► AudioSource (main): voice-activity detection · pause gate
   ▼
ResilientStt ─► LocalSttHost ══ transferable PCM ══► worker thread ── sherpa-onnx streaming transducer (int8)
   ▲            (status, lag, reconnect)   ◄══ partial / final text ══
   ▼
question detector → answer engine → language model → streamed answer
```

* **Streaming, not batch.** The models are *transducers*: audio goes in as it arrives and words come out continuously. Every change of the running text is delivered immediately as a *partial* result; the question detector and the answer engine work on those partials, so an answer can start while the interviewer is still finishing the question.
* **End of speech.** The voice-activity detector notices the speaker stopped (about 300 ms of silence at the default sensitivity) and asks the engine to flush: the worker pads 400 ms of silence, decodes what is pending and emits a *final* result. The engine's own endpoint rule is a backstop.
* **Off the main thread.** Decoding runs in a worker thread, so it can never delay the interface, IPC or the answer stream. Audio capture already runs on the browser's audio thread.
* **No reloads.** The model loads once (10–15 s on the test PC), is shared by every audio stream, stays loaded between sessions, and is released after ten idle minutes. Opening the Live screen or *Settings → Speech → Test speech recognition* loads it ahead of time.
* **One decoding thread.** Two threads were measured too: same latency, but the extra thread spin-waits and burns a whole core.

## The two bundled models

| | **Accurate** (default on this PC) | **Light** |
|---|---|---|
| Model | X-ASR streaming zipformer transducer, 160 ms chunks, int8 (English + Chinese; `sherpa-onnx-x-asr-160ms-…-2026-06-05`) | Zipformer streaming transducer, int8, trained on LibriSpeech (English; `sherpa-onnx-streaming-zipformer-en-2023-06-26`) |
| Files | 169 MB | 73 MB |
| Writes | capitals and some punctuation itself | ALL CAPS, no punctuation (Candor sentence-cases it) |
| Licence | Apache-2.0 | Apache-2.0 |
| Chosen when | *Automatic*: 6+ logical cores and 6+ GB of memory; or *Settings → Speech → Model → Accurate* | *Automatic* otherwise; or *Light* |

Both ship inside the installer and are pinned by SHA-256 (`src/main/stt/local/catalog.json`); `npm run models` fetches and verifies them from their publishers' official locations when building from source.

### How the models were chosen

Candidates were benchmarked on the development PC (AMD Ryzen 5 3500U, 4 cores / 8 threads, no NVIDIA GPU, 13.9 GB RAM, Windows 11) with clips streamed in real time in 40 ms frames, one decoding thread. "First word" is measured from the start of the audio and includes the lead-in silence of each clip; "real-time factor" is decode time divided by audio time.

| Candidate | Result on this PC | Verdict |
|---|---|---|
| Zipformer-en 20M (int8) | ~0.2 s faster to the first word, but failed on whole clips (66 % word error on the synthetic set, 12 % on real speech; two clips returned nothing) | rejected: accuracy |
| **Zipformer-en 70M (int8)** | real-time factor ≈ 0.24, ≈ 23 % of one core; 1.3 % word error on three real read-speech clips, 9.3 % on the synthetic set | **kept as “Light”** |
| Kroko English (int8) | first word ≈ 1.3 s, decode ≈ 190 ms per chunk | rejected: latency |
| NeMo streaming FastConformer transducer, 80 ms (int8) | decode ≈ 200 ms per 80 ms chunk → real-time factor ≈ 2.5, the transcript fell 1–3 s behind | rejected: too heavy for this CPU |
| **X-ASR 160 ms zh-en (int8)** | real-time factor ≈ 0.6, ≈ 52 % of one core; 3.6 % word error on the synthetic set, 2.6 % on the same three real clips (the telephone-band one dropped a letter of a name); better on technical terms | **kept as “Accurate”** |
| Whisper family (tiny/base via ONNX or whisper.cpp), faster-whisper | not adopted: Whisper is a batch model, so live use means re-decoding sliding windows (repeated CPU cost, and partial results that keep changing); faster-whisper also needs a Python runtime | not benchmarked here — a design decision, not a measurement |
| 0.6 B-parameter streaming models (NeMo Nemotron / Parakeet) | ~460 MB downloads and > 1 GB of memory for a laptop that had ≈ 2 GB free | not tried |

## Measured through the shipped architecture

`npm run bench:stt` — host, **real worker thread**, real models, audio paced in real time in 40 ms frames exactly like the microphone path; 12 clips (Windows text-to-speech voices plus one real LibriSpeech recording); the first pass is a discarded warm-up. Measured 2026-09-21 on the PC above while other applications were open (1.4 GB free memory at the start).

| | Light | Accurate |
|---|---|---|
| Model load (once) | 9.1 s | 15.4 s |
| Whole process memory after loading (test runner included) | 216 MB | 339 MB |
| **First words appear** (from the start of the audio; median / p95) | 844 / 887 ms | 849 / 1031 ms |
| Last word present in the running text, relative to the end of the speech (median / p95) | −238 / +203 ms | −146 / +140 ms |
| **End of speech → final transcript** (300 ms voice-activity hangover + flush; median / p95) | 453 / 518 ms | 571 / 667 ms |
| CPU while listening (median / max, share of one core) | 23 % / 27 % | 52 % / 66 % |
| Word error rate, synthetic voices (10 clips, 130 words) | 8.3 % | 3.8 % |
| Word error rate, real recording (LibriSpeech) | 0 % | 0 % |

What the numbers mean in practice:

* Words show up on screen about **0.4–0.5 s after they are spoken** (the model needs a chunk of audio before it can decide). The lead-in silence of each clip makes the “first words” row larger than that.
* From the moment the interviewer stops, the finished transcript is available in **roughly half a second**, of which 300 ms is the deliberate silence the voice-activity detector waits for.
* The accurate model needs about half a core: fine for an interview on this 2019 laptop, but a video call plus a browser plus this can push a weaker PC to its limits. If recognition falls behind the microphone, Candor says so and suggests the light model.
* **Word error on technical terms is the weak spot.** On “Kubernetes and PostgreSQL” the light model wrote “cubagrots and postcra as cue” and the accurate one “Cuba or nets and postgra SQL”. The language model downstream sees the résumé and job description, so it usually recovers the intended term, but a transcript can contain such errors.

The same pipeline in the real app: the packaged installer layout loaded the accurate model in 13.8 s inside Electron's worker thread, and a recorded question played into a fake microphone showed up in the live transcript, was recognised as a behavioural question and streamed an answer (`tests/e2e/local-speech.spec.ts`, `tests/e2e/packaged.spec.ts`).

## Robustness: damaged audio

`npm run bench:robustness` — the same 10 clips (8 synthetic voices and 2 real read-aloud recordings, 184 words), clean and then through deterministic, reproducible damage that approximates a video call. Word error rate, in the configuration the app ships (automatic gain on). Measured 2026-09-21.

| Condition | Accurate | Light |
|---|---|---|
| Clean | 4.9 % | 6.0 % |
| Background noise, 20 dB signal-to-noise | 4.3 % | 6.0 % |
| Background noise, 10 dB signal-to-noise (loud) | 5.4 % | 9.2 % |
| Telephone band (3.4 kHz low-pass) | 4.9 % | 7.1 % |
| Quiet speaker (35 dB down: a call at low volume) | 4.9 % | 6.0 % |
| Room echo (RT60 ≈ 0.4 s) | 3.3 % | 6.5 % |
| **Video call: telephone band + echo + 15 dB noise** | **13.6 %** | **17.9 %** |

* **Automatic gain fixed a real failure found by this benchmark.** Without it the light model went from 6 % to **75 %** word error on the quiet speaker (it was trained on studio-level recordings and simply did not hear it); with it, 6 %. The accurate model did not have the problem. The gain (`agc.ts`) only ever boosts, is capped at +30 dB, follows the loudest recent speech, is held through silence so background noise is not pumped up, and is ramped smoothly so it cannot click; eight unit tests cover it, and the real-engine test suite keeps a quiet-speech regression test.
* The differences between the *with* and *without* gain columns for every other condition are a word or two (noise in the measurement), not a trend. (The no-gain figures are kept in `bench-results/stt-robustness-no-agc.json` when you run the benchmark with `CANDOR_ROBUSTNESS_AGC=0`.)
* The last row is the honest warning: combine three ordinary problems and the error rate roughly triples. Real meeting audio has more (codec artefacts, cross-talk, accents, overlapping speech), so expect worse than this table, not better. The accurate model degrades less than the light one in every row.
* The damage is synthetic and the clips are text-to-speech voices plus two read-aloud recordings — a stress test, not a forecast.


## Limits — read before relying on it

* **The test audio is not a real interview.** It is clean synthetic speech, one real read-aloud recording and simulated damage. Real meeting audio (compression artefacts, several speakers, accents, overlapping speech, a poor microphone) will produce a higher error rate, especially on names and jargon. Try *Settings → Speech → Test speech recognition*, then a mock interview, before depending on it.
* One microphone cannot separate two voices. Use *Computer audio* for a video call so the interviewer's voice arrives on its own.
* The accurate model is English + Chinese; other languages are not supported on device (a cloud service can be added in *Settings → Speech recognition*).
* First use after starting the app takes 10–15 s to load the model (Candor loads it when you open the Live screen). Speech spoken during the first seconds of a cold load is kept for a few seconds and replayed once the engine is ready, but a very long load can lose the start of a question.

## Reproducing the measurements

```bash
npm run models            # fetch + verify the model files (231 MB) into resources/models/stt
npm run build             # the benchmark uses the built worker (out/main/sttWorker.js)
npm run bench:stt         # latency / CPU / memory / accuracy → bench-results/stt-local.json
npm run bench:robustness  # accuracy on noisy / telephone-band / quiet / echoing audio → bench-results/stt-robustness.json
npm run test:speech       # the real engine on real audio (accuracy, partials, early question detection, real-time factor)
npm run speech:fixtures   # regenerate the synthetic test clips (Windows text-to-speech, offline)
```

Results depend on the machine and on what else is running; close other applications for clean numbers.

## Attribution

sherpa-onnx (Apache-2.0, k2-fsa) provides the runtime; the models are Apache-2.0 releases of X-ASR (Gilgamesh-J/X-ASR) and of the icefall Zipformer recipe trained on LibriSpeech (CC BY 4.0 data). The self-test sample is a LibriVox recording from the LibriSpeech corpus. See [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).
