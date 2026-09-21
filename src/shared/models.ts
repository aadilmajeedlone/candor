import type { ProviderKind } from './types';

/**
 * Choosing sensible default models from what a provider actually lists. The order of a raw model list is arbitrary
 * (Google's is alphabetical, so "first Flash" used to mean the oldest one, often with no quota on new projects),
 * and the list also contains models that cannot answer text questions at all (image, speech, embedding, live audio).
 */

const NOT_TEXT_CHAT = /(embed|aqa|imagen|veo|tts|image|live|audio|transcribe|translate|robotics|computer-use|learnlm|gemma|banana|lyria|native|realtime|deep-research)/i;

export function isGeminiChatModel(id: string): boolean {
  return /^gemini-/i.test(id) && !NOT_TEXT_CHAT.test(id);
}

export type GeminiFamily = 'flash-lite' | 'flash' | 'pro' | 'other';

export interface GeminiModelInfo {
  id: string;
  family: GeminiFamily;
  /** e.g. [2, 5] for gemini-2.5-flash; [] for "-latest" aliases. */
  version: number[];
  /** Preview / experimental models usually have the strictest quotas. */
  unstable: boolean;
  alias: boolean;
}

export function parseGeminiModel(id: string): GeminiModelInfo {
  const m = /^gemini-(\d+(?:\.\d+)*)-(flash-lite|flash|pro)/i.exec(id);
  const alias = /-latest$/i.test(id);
  const aliasFamily = /^gemini-(flash-lite|flash|pro)-latest$/i.exec(id)?.[1]?.toLowerCase() as GeminiFamily | undefined;
  return {
    id,
    family: (m?.[2]?.toLowerCase() as GeminiFamily | undefined) ?? aliasFamily ?? 'other',
    version: m?.[1] ? m[1].split('.').map(Number) : [],
    unstable: /(preview|exp|experimental|beta)/i.test(id),
    alias,
  };
}

function compareVersionsDesc(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Newest first; stable before preview at the same version; aliases last (they can move under you). */
function newestFirst(models: GeminiModelInfo[]): GeminiModelInfo[] {
  return [...models].sort((a, b) => Number(a.alias) - Number(b.alias) || compareVersionsDesc(a.version, b.version) || Number(a.unstable) - Number(b.unstable) || a.id.localeCompare(b.id));
}

/** Gemini text models, ordered by how good a first choice they are for `role`. */
export function geminiCandidates(available: string[], role: 'fast' | 'quality'): string[] {
  const all = available.filter(isGeminiChatModel).map(parseGeminiModel);
  // "-latest" aliases move under you, so they are only a last resort.
  const info = all.filter((m) => !m.alias);
  const aliases = all.filter((m) => m.alias);
  const by = (family: GeminiFamily, stable: boolean) => newestFirst(info.filter((m) => m.family === family && m.unstable !== stable));
  const stableFlash = by('flash', true);
  const stableLite = by('flash-lite', true);
  const stablePro = by('pro', true);
  const previews = [...by('flash', false), ...by('flash-lite', false), ...by('pro', false)];
  const aliasOrder = [...aliases].sort((a, b) => (role === 'fast' ? Number(a.family !== 'flash') - Number(b.family !== 'flash') : Number(a.family !== 'pro') - Number(b.family !== 'pro')) || a.id.localeCompare(b.id));
  const order = role === 'fast' ? [...stableFlash, ...stableLite, ...previews, ...stablePro, ...aliasOrder] : [...stablePro, ...stableFlash, ...stableLite, ...previews, ...aliasOrder];
  const seen = new Set<string>();
  return order.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true))).map((m) => m.id);
}

export interface DefaultModels {
  fast: string;
  quality: string;
  /** Other reasonable choices, best first, to try when the first one has no quota or is not available. */
  fastAlternatives: string[];
  qualityAlternatives: string[];
}

/** Unchanged behaviour for OpenAI-compatible and Anthropic lists: the first name that matches, else a fallback. */
function firstMatch(list: string[], re: RegExp, fallback: string): string {
  return list.find((m) => re.test(m)) ?? fallback;
}

export function pickDefaultModels(kind: ProviderKind, available: string[], preset: { fast: string; quality: string }): DefaultModels {
  if (kind === 'google') {
    const fast = geminiCandidates(available, 'fast');
    const quality = geminiCandidates(available, 'quality');
    return {
      fast: fast[0] ?? preset.fast,
      quality: quality[0] ?? fast[0] ?? preset.quality,
      fastAlternatives: fast.slice(1, 6),
      qualityAlternatives: quality.slice(1, 6),
    };
  }
  const fast = firstMatch(available, /haiku|mini|flash|nano|lite|instant|8b/i, preset.fast || available[0] || '');
  const quality = firstMatch(available, /sonnet|opus|gpt-4\.1$|gpt-5$|pro|70b|large/i, preset.quality || available[available.length - 1] || '');
  return { fast, quality, fastAlternatives: [], qualityAlternatives: [] };
}
