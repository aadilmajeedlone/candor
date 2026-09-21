// Fetches the two things `npm run test:local-llm` needs — a real, local, open-source language-model server and a small
// open model — into .model-cache/llm (git-ignored). Nothing here is used by the app itself, and nothing needs an account,
// a key or payment.
//
//   npm run llm:fetch
//
//   llama.cpp `llama-server` (MIT), official Windows CPU build ..... ~19 MB   verified against GitHub's published digest
//   Qwen2.5-1.5B-Instruct, 4-bit GGUF (Apache-2.0), official Qwen ... ~1.1 GB verified against Hugging Face's LFS SHA-256
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '.model-cache', 'llm');
mkdirSync(dir, { recursive: true });

const LLAMA_TAG = 'b11065';
const LLAMA_ASSET = `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`;
const MODEL_REPO = 'Qwen/Qwen2.5-1.5B-Instruct-GGUF';
const MODEL_FILE = 'qwen2.5-1.5b-instruct-q4_k_m.gguf';

async function sha256(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

async function json(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'candor-dev' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function download(url, dest, expectedBytes, expectedSha) {
  if (existsSync(dest) && statSync(dest).size === expectedBytes && (!expectedSha || (await sha256(dest)) === expectedSha)) {
    console.log(`have     ${dest.slice(dir.length + 1)}`);
    return;
  }
  console.log(`fetching ${dest.slice(dir.length + 1)} (${(expectedBytes / 1e6).toFixed(0)} MB) …`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  renameSync(part, dest);
  if (statSync(dest).size !== expectedBytes) throw new Error('size does not match the publisher');
  if (expectedSha && (await sha256(dest)) !== expectedSha) throw new Error('SHA-256 does not match the publisher');
  console.log('         verified');
}

// 1) llama.cpp
const release = await json(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${LLAMA_TAG}`);
const asset = release.assets.find((a) => a.name === LLAMA_ASSET);
if (!asset) throw new Error(`${LLAMA_ASSET} not found in release ${LLAMA_TAG}`);
const zipPath = join(dir, LLAMA_ASSET);
await download(asset.browser_download_url, zipPath, asset.size, (asset.digest ?? '').replace('sha256:', '') || undefined);
const outDir = join(dir, 'llama.cpp');
if (!existsSync(join(outDir, 'llama-server.exe'))) {
  const files = unzipSync(new Uint8Array(readFileSync(zipPath)));
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`unsafe path in archive: ${name}`);
    if (name.endsWith('/')) continue;
    const target = join(outDir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  console.log('extracted llama.cpp');
}

// 2) the model
const tree = await json(`https://huggingface.co/api/models/${MODEL_REPO}/tree/main`);
const file = tree.find((f) => f.path === MODEL_FILE);
if (!file?.lfs?.oid) throw new Error(`${MODEL_FILE} not found in ${MODEL_REPO}`);
await download(`https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}`, join(dir, MODEL_FILE), file.size, file.lfs.oid);
console.log('\nReady: npm run test:local-llm');
