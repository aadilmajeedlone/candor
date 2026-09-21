import type { FactKind } from '@shared/types';
import { clamp } from '@shared/util';
import { synonymTag, tokenize } from '../text/tokenize';
import { cosine, embedLocal } from './embedding';

export type ChunkKind = 'fact' | 'story' | 'jd' | 'company' | 'prepared' | 'note';

export interface Chunk {
  id: string;
  kind: ChunkKind;
  text: string;
  /** Short label for UI chips, e.g. "Amazon — Operations Manager". */
  label?: string;
  /** Id of the underlying fact / story. */
  refId?: string;
  factKind?: FactKind;
  /** Prior multiplier (1 = neutral). */
  weight?: number;
}

export interface Hit {
  chunk: Chunk;
  /** Final relevance 0..1 (after weights and kind boosts). */
  score: number;
  /** Idf-weighted share of the query's content terms present in the chunk. */
  coverage: number;
  cosine: number;
  bm25: number;
}

export interface SearchOptions {
  k?: number;
  minScore?: number;
  kinds?: ChunkKind[];
  kindBoost?: Partial<Record<ChunkKind, number>>;
  /** Strip interview boilerplate from the query ("tell me about a time when…"). Default true. */
  question?: boolean;
}

interface Indexed {
  chunk: Chunk;
  tf: Map<string, number>;
  len: number;
  vec: Float32Array;
}

const K1 = 1.4;
const B = 0.75;

/** Stemmed content terms plus synonym-group tags, so BM25 also benefits from the synonym map. */
function terms(text: string, question: boolean): string[] {
  const toks = tokenize(text, { question });
  const out = [...toks];
  const tags = new Set<string>();
  for (const t of toks) {
    const tag = synonymTag(t);
    if (tag) tags.add(tag);
  }
  out.push(...tags);
  return out;
}

/**
 * In-memory hybrid retriever (BM25 + hashed-embedding cosine + term coverage).
 * Sized for a candidate's material (hundreds of chunks): a search is a linear scan measured in microseconds.
 */
export class HybridIndex {
  private docs: Indexed[] = [];
  private df = new Map<string, number>();
  private totalLen = 0;

  get size(): number {
    return this.docs.length;
  }

  add(chunk: Chunk): void {
    const toks = terms(chunk.text, false);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.push({ chunk, tf, len: toks.length, vec: embedLocal(chunk.text) });
    this.totalLen += toks.length;
  }

  addMany(chunks: Chunk[]): void {
    for (const c of chunks) this.add(c);
  }

  clear(): void {
    this.docs = [];
    this.df.clear();
    this.totalLen = 0;
  }

  search(query: string, opts: SearchOptions = {}): Hit[] {
    const question = opts.question ?? true;
    const qTerms = [...new Set(terms(query, question))];
    if (qTerms.length === 0 || this.docs.length === 0) return [];

    const N = this.docs.length;
    const avgLen = this.totalLen / N || 1;
    const idf = new Map<string, number>();
    let idfSum = 0;
    for (const t of qTerms) {
      const df = this.df.get(t) ?? 0;
      const v = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      idf.set(t, v);
      idfSum += v;
    }
    const qVec = embedLocal(query, { question });
    const allowed = opts.kinds ? new Set(opts.kinds) : null;

    const raw: { d: Indexed; bm25: number; coverage: number; cos: number }[] = [];
    let maxBm25 = 0;
    for (const d of this.docs) {
      if (allowed && !allowed.has(d.chunk.kind)) continue;
      let bm25 = 0;
      let covered = 0;
      for (const t of qTerms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const w = idf.get(t) ?? 0;
        bm25 += (w * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * d.len) / avgLen));
        covered += w;
      }
      if (bm25 > maxBm25) maxBm25 = bm25;
      raw.push({ d, bm25, coverage: idfSum > 0 ? covered / idfSum : 0, cos: cosine(qVec, d.vec) });
    }

    const hits: Hit[] = raw.map(({ d, bm25, coverage, cos }) => {
      const bm25Rel = maxBm25 > 0 ? bm25 / maxBm25 : 0;
      const cosScaled = Math.min(1, Math.max(0, cos) / 0.4);
      let score = 0.5 * coverage + 0.3 * cosScaled + 0.2 * bm25Rel;
      // A chunk that shares nothing with the question must not surface just because it is the "best" of a bad lot.
      if (coverage === 0 && cos < 0.05) score = 0;
      score *= d.chunk.weight ?? 1;
      score *= opts.kindBoost?.[d.chunk.kind] ?? 1;
      return { chunk: d.chunk, score: clamp(score, 0, 1), coverage, cosine: cos, bm25 };
    });

    hits.sort((a, b) => b.score - a.score);
    const min = opts.minScore ?? 0;
    return hits.filter((h) => h.score >= min).slice(0, opts.k ?? 8);
  }
}

/** Split free text into ~`maxWords` chunks on sentence/bullet boundaries (for JD and company notes). */
export function chunkText(text: string, maxWords = 60): string[] {
  const units = text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.replace(/^[\s•\-*–·▪●○◦]+/, '').trim())
    .filter((s) => s.length > 2);
  const chunks: string[] = [];
  let cur: string[] = [];
  let count = 0;
  for (const u of units) {
    const n = u.split(/\s+/).length;
    if (count + n > maxWords && cur.length > 0) {
      chunks.push(cur.join(' '));
      cur = [];
      count = 0;
    }
    cur.push(u);
    count += n;
  }
  if (cur.length > 0) chunks.push(cur.join(' '));
  return chunks;
}
