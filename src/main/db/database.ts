import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations';

type SqlValue = string | number | bigint | null | Uint8Array;

/** Resolve the built-in SQLite through process.getBuiltinModule so bundlers never try to resolve it. */
function loadSqlite(): typeof import('node:sqlite') {
  const mod = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined;
  if (!mod) throw new Error('This runtime does not provide node:sqlite (Node 22.5+ / Electron 35+ required).');
  return mod;
}

/**
 * Thin synchronous wrapper over node:sqlite: statement cache, undefined→null binding, transactions and
 * versioned migrations. SQLite in WAL mode is fast enough that synchronous access from the main process is
 * appropriate for this app's data volumes.
 */
export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(readonly path: string) {
    if (path !== ':memory:') {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    const { DatabaseSync } = loadSqlite();
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private bind(params: unknown[]): SqlValue[] {
    return params.map((p) => {
      if (p === undefined || p === null) return null;
      if (typeof p === 'boolean') return p ? 1 : 0;
      return p as SqlValue;
    });
  }

  run(sql: string, ...params: unknown[]): { changes: number } {
    const r = this.stmt(sql).run(...this.bind(params));
    return { changes: Number(r.changes) };
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...this.bind(params)) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...this.bind(params)) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  get version(): number {
    return this.get<{ v: number | null }>('SELECT MAX(id) AS v FROM schema_migrations')?.v ?? 0;
  }

  private migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    const applied = new Set(this.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      this.tx(() => {
        this.raw.exec(m.sql);
        this.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, Date.now());
      });
    }
  }

  close(): void {
    this.cache.clear();
    try {
      this.raw.close();
    } catch {
      /* already closed */
    }
  }
}
