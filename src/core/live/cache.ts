import type { AnswerMode } from '@shared/types';
import { tokenJaccard } from '../text/tokenize';
import { cosine, embedLocal } from '../retrieval/embedding';

export interface CacheEntry {
  question: string;
  vec: Float32Array;
  mode: AnswerMode;
  /** Hash of the interview context the answer was written for. A different context never matches. */
  ctxVersion: string;
  answer: string;
  source: 'live' | 'prepared';
  createdAt: number;
  hits: number;
}

export interface CacheHit {
  entry: CacheEntry;
  similarity: number;
}

/**
 * Semantic answer cache. A hit needs both a high blended similarity and strong content-word overlap, so
 * "biggest strength" never matches "biggest weakness". Scope is (context version, mode): an answer written for
 * another interview or in another mode is never returned.
 */
export class AnswerCache {
  private entries: CacheEntry[] = [];
  constructor(
    private readonly max = 300,
    private readonly threshold = 0.85,
    private readonly minJaccard = 0.75,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  lookup(question: string, mode: AnswerMode, ctxVersion: string, alsoVersions: string[] = []): CacheHit | null {
    if (this.entries.length === 0) return null;
    const qVec = embedLocal(question, { question: true });
    let best: CacheHit | null = null;
    for (const e of this.entries) {
      if (e.mode !== mode || (e.ctxVersion !== ctxVersion && !alsoVersions.includes(e.ctxVersion))) continue;
      const jac = tokenJaccard(question, e.question);
      if (jac < this.minJaccard) continue;
      const sim = 0.5 * cosine(qVec, e.vec) + 0.5 * jac;
      if (sim >= this.threshold && (!best || sim > best.similarity)) best = { entry: e, similarity: sim };
    }
    if (best) best.entry.hits++;
    return best;
  }

  put(entry: Omit<CacheEntry, 'vec' | 'hits' | 'createdAt'> & { createdAt?: number }): void {
    const vec = embedLocal(entry.question, { question: true });
    // Replace a near-identical entry instead of accumulating duplicates.
    const idx = this.entries.findIndex(
      (e) => e.mode === entry.mode && e.ctxVersion === entry.ctxVersion && tokenJaccard(e.question, entry.question) >= 0.95,
    );
    const full: CacheEntry = { ...entry, vec, hits: 0, createdAt: entry.createdAt ?? Date.now() };
    if (idx >= 0) this.entries[idx] = full;
    else this.entries.push(full);
    if (this.entries.length > this.max) {
      // Drop the least valuable live entry first; prepared answers are kept longest.
      let victim = -1;
      let score = Infinity;
      this.entries.forEach((e, i) => {
        const s = e.hits * 10 + e.createdAt / 1e12 + (e.source === 'prepared' ? 1000 : 0);
        if (s < score) {
          score = s;
          victim = i;
        }
      });
      if (victim >= 0) this.entries.splice(victim, 1);
    }
  }

  /** Remove every entry for a question (used when the user marks an answer "incorrect"). */
  evict(question: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => tokenJaccard(e.question, question) < 0.75);
    return before - this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}
