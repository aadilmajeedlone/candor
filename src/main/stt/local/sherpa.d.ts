// The native speech library ships JavaScript without type declarations. Only the parts Candor uses are described,
// in src/main/stt/local/recognizer.ts (SherpaModule); this file just lets the worker import the package by name.
declare module 'sherpa-onnx-node';
