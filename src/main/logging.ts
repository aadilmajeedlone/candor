import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structured logger with redaction. It never logs prompts, transcripts, audio or request bodies: callers pass
 * short event messages and small metadata only. Anything that looks like a credential is masked, and values
 * registered with `registerSecret` are masked wherever they appear.
 */
type Level = 'error' | 'warn' | 'info' | 'debug';
const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /\bAQ\.[A-Za-z0-9_-]{20,}/g, // Google authorization keys
  /\bya29\.[A-Za-z0-9_-]{20,}/g, // Google OAuth access tokens
  /\b1\/\/[A-Za-z0-9_-]{20,}/g, // Google OAuth refresh tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JSON web tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /(x-api-key|api[-_]?key|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
  /[?&](key|api_key|token|access_token)=[^&\s"']+/gi,
];

const secretValues = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 6) secretValues.add(value);
}

export function forgetSecret(value: string | null | undefined): void {
  if (value) secretValues.delete(value);
}

export function redact(input: string): string {
  let out = input;
  for (const s of secretValues) out = out.split(s).join('***');
  for (const re of PATTERNS) out = out.replace(re, (m) => (/^(bearer|token|basic)\s/i.test(m) ? m.replace(/\s.*/, ' ***') : '***'));
  return out;
}

class Logger {
  private level: Level = 'info';
  private dir: string | null = null;
  private file: string | null = null;

  configure(opts: { level?: Level; dir?: string }): void {
    if (opts.level) this.level = opts.level;
    if (opts.dir) {
      try {
        if (!existsSync(opts.dir)) mkdirSync(opts.dir, { recursive: true });
        this.dir = opts.dir;
        this.file = join(opts.dir, 'candor.log');
      } catch {
        this.dir = null;
        this.file = null;
      }
    }
  }

  private write(level: Level, scope: string, msg: string, meta?: Record<string, unknown>): void {
    if (ORDER[level] > ORDER[this.level]) return;
    let metaStr = '';
    if (meta) {
      try {
        metaStr = ' ' + JSON.stringify(meta);
      } catch {
        metaStr = '';
      }
    }
    const line = redact(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${metaStr}`);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (this.file) {
      try {
        if (existsSync(this.file) && statSync(this.file).size > 1_000_000) renameSync(this.file, join(this.dir ?? '.', 'candor.old.log'));
        appendFileSync(this.file, line + '\n');
      } catch {
        /* logging must never throw */
      }
    }
  }

  scoped(scope: string) {
    return {
      error: (m: string, meta?: Record<string, unknown>) => this.write('error', scope, m, meta),
      warn: (m: string, meta?: Record<string, unknown>) => this.write('warn', scope, m, meta),
      info: (m: string, meta?: Record<string, unknown>) => this.write('info', scope, m, meta),
      debug: (m: string, meta?: Record<string, unknown>) => this.write('debug', scope, m, meta),
    };
  }
}

export const logger = new Logger();
export type ScopedLogger = ReturnType<Logger['scoped']>;
export const log = (scope: string): ScopedLogger => logger.scoped(scope);
