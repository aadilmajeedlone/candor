// Fetches and verifies the on-device speech models (about 231 MB) into resources/models/stt.
//
//   npm run models          download whatever is missing, then verify every file's SHA-256
//   npm run models:verify   verify only (used before packaging); exits 1 if anything is missing or wrong
//
// Sources are the official upstream locations only, and every file is checked against a hash pinned in
// src/main/stt/local/catalog.json, so a changed or tampered download is rejected. No account, key or payment is involved.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'resources', 'models', 'stt');
const verifyOnly = process.argv.includes('--verify');

const LOCAL_MODELS = JSON.parse(readFileSync(join(root, 'src/main/stt/local/catalog.json'), 'utf8'));

const SOURCES = {
  'zipformer-en-70m': { kind: 'huggingface', repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26' },
  'x-asr-160': {
    kind: 'github-archive',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2',
    sha256: '8a6fca056e1a342546edd78be4d50274e2c01898e7b8ae8fc336f6410319c399', // GitHub's published digest of the archive
    folder: 'sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05',
  },
};

// The sample clip for "Test speech recognition": a LibriVox recording from the LibriSpeech corpus (CC BY 4.0).
const SAMPLE = { repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26', file: 'test_wavs/0.wav', name: 'selftest.wav', bytes: 212044, sha256: '6bc58a4efdf20daac252b6b1502632601a71efe0308f6757dc1eda34891a7e4f' };

async function sha256(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

async function good(path, bytes, hash) {
  try {
    return statSync(path).size === bytes && (await sha256(path)) === hash;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  renameSync(part, dest);
}

let failed = false;
const say = (s) => console.log(s);

for (const [id, spec] of Object.entries(LOCAL_MODELS)) {
  const dir = join(target, id);
  const missing = [];
  for (const f of Object.values(spec.files)) if (!(await good(join(dir, f.name), f.bytes, f.sha256))) missing.push(f);
  if (missing.length === 0) {
    say(`ok       ${id}  (${Object.values(spec.files).length} files verified)`);
    continue;
  }
  if (verifyOnly) {
    say(`MISSING  ${id}: ${missing.map((f) => f.name).join(', ')}  — run "npm run models"`);
    failed = true;
    continue;
  }
  const src = SOURCES[id];
  say(`fetching ${id} (${missing.length} file${missing.length > 1 ? 's' : ''}) from ${src.kind === 'huggingface' ? 'huggingface.co/' + src.repo : 'github.com/k2-fsa/sherpa-onnx'}`);
  mkdirSync(dir, { recursive: true });
  try {
    if (src.kind === 'huggingface') {
      for (const f of missing) await download(`https://huggingface.co/${src.repo}/resolve/main/${f.name}`, join(dir, f.name));
    } else {
      const work = join(tmpdir(), `candor-models-${process.pid}`);
      mkdirSync(work, { recursive: true });
      const archive = join(work, 'model.tar.bz2');
      await download(src.url, archive);
      if ((await sha256(archive)) !== src.sha256) throw new Error('The downloaded archive does not match its published SHA-256.');
      execFileSync('tar', ['-xjf', archive, '-C', work], { stdio: 'inherit' }); // bsdtar ships with Windows 10+, and with macOS/Linux
      for (const f of missing) copyFileSync(join(work, src.folder, f.name), join(dir, f.name));
      rmSync(work, { recursive: true, force: true });
    }
  } catch (e) {
    say(`FAILED   ${id}: ${e instanceof Error ? e.message : String(e)}`);
    failed = true;
    continue;
  }
  for (const f of Object.values(spec.files)) {
    if (!(await good(join(dir, f.name), f.bytes, f.sha256))) {
      say(`FAILED   ${id}: ${f.name} does not match its pinned SHA-256`);
      rmSync(join(dir, f.name), { force: true });
      failed = true;
    }
  }
  if (!failed) say(`ok       ${id}`);
}

const samplePath = join(target, SAMPLE.name);
if (await good(samplePath, SAMPLE.bytes, SAMPLE.sha256)) say(`ok       ${SAMPLE.name}`);
else if (verifyOnly) {
  say(`MISSING  ${SAMPLE.name}  — run "npm run models"`);
  failed = true;
} else {
  try {
    await download(`https://huggingface.co/${SAMPLE.repo}/resolve/main/${SAMPLE.file}`, samplePath);
    if (await good(samplePath, SAMPLE.bytes, SAMPLE.sha256)) say(`ok       ${SAMPLE.name}`);
    else throw new Error('does not match its pinned SHA-256');
  } catch (e) {
    say(`FAILED   ${SAMPLE.name}: ${e instanceof Error ? e.message : String(e)}`);
    failed = true;
  }
}

if (existsSync(target)) say(failed ? '\nSome speech model files are missing or wrong.' : '\nSpeech models are complete.');
process.exit(failed ? 1 : 0);
