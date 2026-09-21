# Third-party notices

Candor is private software (see `package.json`). It bundles or uses the following third-party components, each under its own licence. Licences are taken from the upstream projects' own pages and package metadata; check them before redistributing anything.

## Shipped in the installer

| Component | Used for | Licence | Source |
|---|---|---|---|
| Electron, Chromium | The application shell | MIT / BSD-style (Chromium) | <https://www.electronjs.org> |
| React, React DOM, zustand, lucide-react | Interface | MIT / ISC | npm |
| `ws`, `zod`, `fflate`, `unpdf` (pdf.js) | WebSocket client, validation, ZIP, PDF text | MIT / Apache-2.0 | npm |
| `google-auth-library` | Google sign-in (Application Default Credentials) | Apache-2.0 | npm |
| Fontsource: Inter, Instrument Serif | Interface fonts | OFL-1.1 | npm |
| **sherpa-onnx** (`sherpa-onnx-node`, `sherpa-onnx-win-x64`) | On-device speech recognition runtime | Apache-2.0 (k2-fsa) | <https://github.com/k2-fsa/sherpa-onnx> |
| **ONNX Runtime** (`onnxruntime.dll`, inside `sherpa-onnx-win-x64`) | Neural-network inference | MIT (Microsoft) | <https://github.com/microsoft/onnxruntime> |
| **X-ASR streaming zipformer transducer**, 160 ms, zh-en, int8 — *the "Accurate" speech model* | Speech recognition | Apache-2.0 | <https://github.com/Gilgamesh-J/X-ASR>, distributed via <https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models> |
| **Zipformer streaming transducer, English, int8** (`sherpa-onnx-streaming-zipformer-en-2023-06-26`) — *the "Light" speech model* | Speech recognition | Apache-2.0 recipe (k2-fsa/icefall); trained on LibriSpeech (CC BY 4.0) | <https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26> |
| LibriSpeech sample clip (`selftest.wav`, a LibriVox recording) | "Test speech recognition" | CC BY 4.0 (LibriSpeech); public-domain recording (LibriVox) | <https://www.openslr.org/12> |

The model files are pinned by SHA-256 in `src/main/stt/local/catalog.json` and verified by `npm run models`.

## Used for development and tests only (not shipped)

| Component | Used for | Licence |
|---|---|---|
| llama.cpp (`llama-server`) | A real local language-model server for `npm run test:local-llm` | MIT |
| Qwen2.5-1.5B-Instruct (GGUF, 4-bit) | The model that test runs | Apache-2.0 |
| Windows text-to-speech voices (Microsoft David and Zira) | Synthetic test speech (`npm run speech:fixtures`) | Part of Windows; the generated clips are test fixtures only |
| Playwright, vitest, ESLint, TypeScript, electron-builder, electron-vite | Build, lint and test | MIT / Apache-2.0 / BSD |
