import { hash53 } from '@shared/util';
import { synonymTag, tokenize } from '../text/tokenize';

/**
 * Local "hashed" embedding: signed feature hashing over stemmed unigrams, bigrams, synonym-group tags and
 * character trigrams, L2-normalised. It runs in microseconds with no model download and no network.
 *
 * Honest scope: this is a lexical/semantic-lite representation, not a neural embedding. It catches word
 * variants and a curated synonym map, not arbitrary paraphrase. An optional cloud embedder can be layered on
 * top (see `EmbeddingProvider`) when the user enables it.
 */
export const LOCAL_EMBED_DIM = 1024;

export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

function addFeature(vec: Float32Array, feature: string, weight: number): void {
  const h = hash53(feature);
  const idx = h % vec.length;
  const sign = (Math.floor(h / vec.length) & 1) === 0 ? 1 : -1;
  vec[idx] = (vec[idx] ?? 0) + sign * weight;
}

export function embedLocal(text: string, opts: { question?: boolean; dim?: number } = {}): Float32Array {
  const dim = opts.dim ?? LOCAL_EMBED_DIM;
  const vec = new Float32Array(dim);
  const toks = tokenize(text, { question: opts.question });
  if (toks.length === 0) return vec;

  const tf = new Map<string, number>();
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);

  for (const [t, c] of tf) {
    const w = 1 + Math.log(c);
    addFeature(vec, `u:${t}`, w);
    const tag = synonymTag(t);
    if (tag) addFeature(vec, `g:${tag}`, 0.7 * w);
    if (t.length >= 5) {
      for (let i = 0; i + 3 <= t.length; i++) addFeature(vec, `c:${t.slice(i, i + 3)}`, 0.12 * w);
    }
  }
  for (let i = 0; i + 1 < toks.length; i++) addFeature(vec, `b:${toks[i]}_${toks[i + 1]}`, 0.6);

  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export const localEmbedder: EmbeddingProvider = {
  id: 'local-hash-1024',
  dim: LOCAL_EMBED_DIM,
  embed: (texts) => Promise.resolve(texts.map((t) => embedLocal(t))),
};
