import type { Db } from '../db/database';
import { forgetSecret, registerSecret } from '../logging';

/** Minimal surface of Electron's safeStorage, so the store can be tested with a fake. */
export interface Cipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

/** Environment variable that can supply a key when none is stored. */
export const ENV_KEY_NAMES: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  deepgram: ['DEEPGRAM_API_KEY', 'STT_API_KEY'],
  assemblyai: ['ASSEMBLYAI_API_KEY', 'STT_API_KEY'],
};

export type KeySource = 'stored' | 'env' | 'none';

export class SecretStore {
  private readonly memo = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get available(): boolean {
    return this.cipher.isAvailable();
  }

  /** Encrypt and store a secret. Refuses (rather than falling back to plaintext) if the OS keystore is unavailable. */
  set(name: string, value: string): void {
    const v = value.trim();
    if (!v) throw new Error('The key is empty.');
    if (v.length > 4096) throw new Error('The key is too long.');
    if (!this.cipher.isAvailable()) throw new Error('Secure storage is not available on this system, so the key was not saved.');
    const cipherText = this.cipher.encrypt(v).toString('base64');
    const hint = v.length >= 8 ? `…${v.slice(-4)}` : '••••';
    this.db.run(
      `INSERT INTO secrets (name, ciphertext, hint, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at`,
      name,
      cipherText,
      hint,
      Date.now(),
    );
    const old = this.memo.get(name);
    if (old) forgetSecret(old);
    this.memo.set(name, v);
    registerSecret(v);
  }

  /** Plaintext access is for the main process only; nothing here is exposed over IPC. */
  get(name: string, envGroup?: string): string | null {
    const cached = this.memo.get(name);
    if (cached) return cached;
    const row = this.db.get<{ ciphertext: string }>('SELECT ciphertext FROM secrets WHERE name = ?', name);
    if (row && this.cipher.isAvailable()) {
      try {
        const plain = this.cipher.decrypt(Buffer.from(row.ciphertext, 'base64'));
        this.memo.set(name, plain);
        registerSecret(plain);
        return plain;
      } catch {
        // Ciphertext from another OS user/machine: treat as absent instead of crashing.
      }
    }
    return envGroup ? this.fromEnv(envGroup) : null;
  }

  source(name: string, envGroup?: string): KeySource {
    if (this.db.get('SELECT 1 AS x FROM secrets WHERE name = ?', name)) return 'stored';
    return envGroup && this.fromEnv(envGroup) ? 'env' : 'none';
  }

  hint(name: string): string | null {
    return this.db.get<{ hint: string | null }>('SELECT hint FROM secrets WHERE name = ?', name)?.hint ?? null;
  }

  delete(name: string): void {
    const old = this.memo.get(name);
    if (old) forgetSecret(old);
    this.memo.delete(name);
    this.db.run('DELETE FROM secrets WHERE name = ?', name);
  }

  clearAll(): void {
    for (const v of this.memo.values()) forgetSecret(v);
    this.memo.clear();
    this.db.run('DELETE FROM secrets');
  }

  private fromEnv(group: string): string | null {
    for (const n of ENV_KEY_NAMES[group] ?? []) {
      const v = this.env[n]?.trim();
      if (v) {
        registerSecret(v);
        return v;
      }
    }
    return null;
  }
}

/** Which env group a provider uses when it has no stored key. */
export function envGroupFor(kind: 'openai-compatible' | 'anthropic' | 'google', baseUrl: string): string | undefined {
  if (kind === 'anthropic') return 'anthropic';
  if (kind === 'google') return 'google';
  return /(^|\/\/)api\.openai\.com/.test(baseUrl) ? 'openai' : undefined;
}
