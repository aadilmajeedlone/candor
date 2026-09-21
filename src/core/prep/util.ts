export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lowercase, strip punctuation to single spaces; keeps letters, digits and the symbols that carry meaning in résumés. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}%$+#]+/gu, ' ')
    .trim();
}

export function contentTokens(s: string): string[] {
  return norm(s)
    .split(' ')
    .filter((t) => t.length > 2 || /\d/.test(t));
}

/** Share of `a`'s content tokens that occur in `b`. */
export function tokenCoverage(a: string, b: string): number {
  const A = contentTokens(a);
  if (A.length === 0) return 0;
  const B = new Set(contentTokens(b));
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / A.length;
}
