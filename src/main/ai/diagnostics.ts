import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../logging';

/**
 * Development-only capture of what a model actually sent back, for diagnosing formatting problems.
 *
 * OFF unless the person starts Candor with `CANDOR_DEBUG_AI=1` (raw model replies) or `CANDOR_DEBUG_AI=full` (replies and
 * the prompts that produced them). Nothing is sent anywhere: lines are appended to `ai-debug.jsonl` in the logs folder,
 * size-capped, with anything that looks like a credential masked. Prompts contain résumé and job text, so prompt capture
 * needs the explicit `full` opt-in, and the app says at startup when either mode is on.
 *
 * The normal log (`candor.log`) never contains prompts or replies, only sizes, finish reasons and error classes.
 */

const MAX_FILE = 5_000_000;
const MAX_TEXT = 100_000;

export interface DebugText {
  system?: string;
  user?: string;
  reply?: string;
}

class AiDebug {
  private file: string | null = null;
  private dir: string | null = null;
  private withPrompts = false;

  get enabled(): boolean {
    return this.file !== null;
  }

  get capturesPrompts(): boolean {
    return this.enabled && this.withPrompts;
  }

  get path(): string | null {
    return this.file;
  }

  /** `mode` is the value of CANDOR_DEBUG_AI. Anything other than 1/true/on/full leaves capture off. */
  configure(opts: { mode: string | undefined; dir: string }): void {
    const mode = (opts.mode ?? '').trim().toLowerCase();
    this.file = null;
    this.dir = null;
    this.withPrompts = false;
    if (!['1', 'true', 'on', 'yes', 'full'].includes(mode)) return;
    try {
      if (!existsSync(opts.dir)) mkdirSync(opts.dir, { recursive: true });
      this.dir = opts.dir;
      this.file = join(opts.dir, 'ai-debug.jsonl');
      this.withPrompts = mode === 'full';
    } catch {
      this.file = null;
    }
  }

  /** Append one event. `meta` must already be free of content; `text` is redacted and capped. Never throws. */
  record(event: string, meta: Record<string, unknown>, text?: DebugText): void {
    if (!this.file) return;
    try {
      // Each string is masked on its own, before serialising, so a match can never damage the line's JSON structure.
      const entry: Record<string, unknown> = { at: new Date().toISOString(), event };
      for (const [k, v] of Object.entries(meta)) entry[k] = typeof v === 'string' ? redact(v) : v;
      if (text?.reply !== undefined) entry.reply = redact(clip(text.reply));
      if (this.withPrompts) {
        if (text?.system !== undefined) entry.system = redact(clip(text.system));
        if (text?.user !== undefined) entry.user = redact(clip(text.user));
      } else if (text?.system !== undefined || text?.user !== undefined) {
        entry.promptChars = { system: text.system?.length ?? 0, user: text.user?.length ?? 0 };
      }
      if (existsSync(this.file) && statSync(this.file).size > MAX_FILE) renameSync(this.file, join(this.dir ?? '.', 'ai-debug.old.jsonl'));
      appendFileSync(this.file, JSON.stringify(entry) + '\n');
    } catch {
      /* diagnostics must never affect the app */
    }
  }
}

function clip(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…[${s.length - MAX_TEXT} more characters]` : s;
}

export const aiDebug = new AiDebug();
