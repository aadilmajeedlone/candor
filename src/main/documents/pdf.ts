import { getDocumentProxy } from 'unpdf';
import { MAX_PDF_PAGES } from './limits';

export interface PdfResult {
  text: string;
  pages: number;
  warnings: string[];
}

interface Item {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

/**
 * Rebuild reading order from positioned text runs. Runs are grouped into lines by baseline. Real résumés mix
 * full-width sections with side-by-side blocks (sidebar layouts, "Education | Certifications"), so a single
 * page-wide test is not enough: the gutter is inferred from lines that have a wide internal gap, full-width
 * lines act as region boundaries, and each two-column region is read column by column.
 */
export function itemsToText(items: Item[], pageWidth: number): string {
  const clean = items.filter((i) => i.str.trim().length > 0);
  if (clean.length === 0) return '';
  const h = median(clean.map((i) => i.h).filter((v) => v > 0)) || 10;
  const lines = clusterLines(clean, h);
  const gutter = findGutter(lines, pageWidth, h);
  if (gutter === null) return renderLines(lines, h);

  const out: string[] = [];
  let region: Line[] = [];
  const flush = (): void => {
    if (region.length === 0) return;
    const left: Line[] = [];
    const right: Line[] = [];
    for (const ln of region) {
      const l = ln.items.filter((i) => i.x + i.w / 2 < gutter);
      const r = ln.items.filter((i) => i.x + i.w / 2 >= gutter);
      if (l.length) left.push({ y: ln.y, items: l });
      if (r.length) right.push({ y: ln.y, items: r });
    }
    // Only a genuine two-column block (real content on both sides) is split; otherwise keep the natural order.
    if (left.length >= 2 && right.length >= 2) out.push(renderLines(left, h), renderLines(right, h));
    else out.push(renderLines(region, h));
    region = [];
  };
  for (const ln of lines) {
    if (crossesGutter(ln, gutter, h)) {
      flush();
      out.push(renderLines([ln], h));
    } else region.push(ln);
  }
  flush();
  return out.filter(Boolean).join('\n');
}

interface Line {
  y: number;
  items: Item[];
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  return s.length ? (s[Math.floor(s.length / 2)] ?? 0) : 0;
}

function clusterLines(items: Item[], h: number): Line[] {
  const tol = h * 0.55;
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - it.y) <= tol) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

function renderLines(lines: Line[], h: number): string {
  const out: string[] = [];
  let prevY: number | null = null;
  for (const line of lines) {
    let s = '';
    let prevEnd: number | null = null;
    for (const it of line.items) {
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        if (gap > h * 2.5) s += '\t';
        else if (gap > h * 0.12 && !s.endsWith(' ') && !it.str.startsWith(' ')) s += ' ';
      }
      s += it.str;
      prevEnd = it.x + it.w;
    }
    // A large vertical jump is a paragraph/section break.
    if (prevY !== null && prevY - line.y > h * 1.9) out.push('');
    out.push(s.replace(/[ \t]+$/g, ''));
    prevY = line.y;
  }
  return out.join('\n');
}

const wideGap = (h: number): number => Math.max(h * 3, 18);

/** The widest empty span between consecutive runs of a line that falls in the middle of the page, if any. */
function midGap(line: Line, lo: number, hi: number, h: number): [number, number] | null {
  let best: [number, number] | null = null;
  for (let i = 1; i < line.items.length; i++) {
    const a = line.items[i - 1];
    const b = line.items[i];
    const start = a.x + a.w;
    const end = b.x;
    if (end - start >= wideGap(h) && start < hi && end > lo && (!best || end - start > best[1] - best[0])) best = [start, end];
  }
  return best;
}

function findGutter(lines: Line[], pageWidth: number, h: number): number | null {
  if (pageWidth <= 0) return null;
  const lo = pageWidth * 0.2;
  const hi = pageWidth * 0.8;
  const gaps: [number, number][] = [];
  for (const l of lines) {
    const g = midGap(l, lo, hi, h);
    if (g) gaps.push(g);
  }
  if (gaps.length < 2) return null;
  let bestPoint = 0;
  let bestCount = 0;
  for (const [a, b] of gaps) {
    const p = (a + b) / 2;
    const count = gaps.filter(([x, y]) => x <= p && y >= p).length;
    if (count > bestCount) {
      bestCount = count;
      bestPoint = p;
    }
  }
  if (bestCount < 2) return null;
  const inter = gaps.filter(([x, y]) => x <= bestPoint && y >= bestPoint);
  const from = Math.max(...inter.map(([x]) => x));
  const to = Math.min(...inter.map(([, y]) => y));
  const g = from <= to ? (from + to) / 2 : bestPoint;
  // Require real two-column content: at least two rows of text on each side of the gutter.
  let leftRows = 0;
  let rightRows = 0;
  for (const l of lines) {
    if (crossesGutter(l, g, h)) continue;
    if (l.items.some((i) => i.x + i.w / 2 < g)) leftRows++;
    if (l.items.some((i) => i.x + i.w / 2 >= g)) rightRows++;
  }
  return leftRows >= 2 && rightRows >= 2 ? g : null;
}

/** A line crosses the gutter when it has text on both sides with no wide gap at the gutter (i.e. full-width text). */
function crossesGutter(line: Line, g: number, h: number): boolean {
  let left = false;
  let right = false;
  for (const it of line.items) {
    if (it.x < g - 2 && it.x + it.w > g + 2) return true;
    if (it.x + it.w / 2 < g) left = true;
    else right = true;
  }
  if (!(left && right)) return false;
  // Both sides present: a wide empty gap at the gutter means two columns; otherwise it is one continuous line.
  for (let i = 1; i < line.items.length; i++) {
    const a = line.items[i - 1];
    const b = line.items[i];
    if (a.x + a.w <= g + 2 && b.x >= g - 2 && b.x - (a.x + a.w) >= wideGap(h)) return false;
  }
  return true;
}

export async function extractPdf(data: Uint8Array): Promise<PdfResult> {
  const warnings: string[] = [];
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js may transfer the buffer; hand it a copy so the caller's bytes stay intact.
    pdf = await getDocumentProxy(new Uint8Array(data));
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    const msg = err instanceof Error ? err.message : '';
    if (/Password/i.test(name) || /password/i.test(msg)) {
      throw Object.assign(new Error('This PDF is password-protected. Remove the password and try again.'), { docCode: 'encrypted' });
    }
    throw Object.assign(new Error('This PDF could not be read. It may be corrupted; try exporting it again or paste the text.'), { docCode: 'corrupted' });
  }
  const total = pdf.numPages;
  const limit = Math.min(total, MAX_PDF_PAGES);
  if (total > limit) warnings.push(`This PDF has ${total} pages; only the first ${limit} were read.`);
  const pages: string[] = [];
  try {
    for (let p = 1; p <= limit; p++) {
      const page = await pdf.getPage(p);
      const view = page.view;
      const width = (view[2] ?? 612) - (view[0] ?? 0);
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const raw of content.items as TextItemLike[]) {
        if (typeof raw.str !== 'string' || !raw.transform) continue;
        items.push({ str: raw.str, x: raw.transform[4] ?? 0, y: raw.transform[5] ?? 0, w: raw.width ?? 0, h: raw.height || Math.abs(raw.transform[3] ?? 0) || 10 });
      }
      pages.push(itemsToText(items, width));
    }
  } catch {
    throw Object.assign(new Error('This PDF could not be read completely. It may be corrupted; try exporting it again or paste the text.'), { docCode: 'corrupted' });
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
  return { text: pages.join('\n\n'), pages: total, warnings };
}
