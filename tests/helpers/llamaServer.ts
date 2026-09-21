import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

/**
 * A real local language-model server: llama.cpp's `llama-server` (MIT, official build) running a small open model.
 * It speaks the same OpenAI-compatible API a friend's GPU server, Ollama or LM Studio would, so it exercises Candor's
 * provider path for real — streaming, model listing, timeouts — with no mock in between. Free and offline.
 *
 * `npm run llm:fetch` downloads and verifies the files into .model-cache/llm (git-ignored).
 */

export const LLM_DIR = resolve(__dirname, '../../.model-cache/llm');
export const LLAMA_EXE = join(LLM_DIR, 'llama.cpp', 'llama-server.exe');
export const LLAMA_MODEL = join(LLM_DIR, 'qwen2.5-1.5b-instruct-q4_k_m.gguf');

export function llamaAvailable(): boolean {
  return existsSync(LLAMA_EXE) && existsSync(LLAMA_MODEL);
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

export interface LlamaServer {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:52123/v1 */
  url: string;
  port: number;
  loadMs: number;
  stop(): Promise<void>;
  log(): string;
}

export async function startLlamaServer(opts: { ctx?: number; threads?: number; batchThreads?: number; readyTimeoutMs?: number } = {}): Promise<LlamaServer> {
  const port = await freePort();
  const args = [
    '-m', LLAMA_MODEL,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-c', String(opts.ctx ?? 4096),
    '-t', String(opts.threads ?? 4),
    '-tb', String(opts.batchThreads ?? 8),
    '--parallel', '1',
    '--no-webui',
  ];
  let out = '';
  const child: ChildProcess = spawn(LLAMA_EXE, args, { cwd: join(LLM_DIR, 'llama.cpp'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout?.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-20_000)));
  child.stderr?.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-20_000)));
  let exited = false;
  child.once('exit', () => (exited = true));

  const t0 = Date.now();
  const deadline = t0 + (opts.readyTimeoutMs ?? 120_000);
  for (;;) {
    if (exited) throw new Error(`llama-server exited early:\n${out.slice(-2000)}`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`llama-server was not ready in time:\n${out.slice(-2000)}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const loadMs = Date.now() - t0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    loadMs,
    log: () => out,
    stop: () =>
      new Promise<void>((res) => {
        if (exited) return res();
        child.once('exit', () => res());
        child.kill();
        setTimeout(res, 3000);
      }),
  };
}
