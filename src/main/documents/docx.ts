import { strFromU8, unzipSync } from 'fflate';

export interface DocxResult {
  text: string;
  warnings: string[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Convert WordprocessingML to plain text, preserving paragraph breaks, tabs, line breaks and table structure
 * (each row on its own line, cells joined with " | ").
 */
export function wordXmlToText(xml: string): string {
  const out: string[] = [];
  // Inside a table cell, text is collected separately so a row can be emitted as "cell | cell | cell".
  let cell: string[] | null = null;
  let cellDepth = 0;
  let row: string[] | null = null;
  const put = (s: string): void => {
    (cell ?? out).push(s);
  };
  const re = /<(\/?)w:(p|tc|tr|t|tab|br|cr|noBreakHyphen)\b([^>]*?)(\/?)>|([^<]+)/g;
  let inText = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, closing, tag, , selfClose, text] = m;
    if (text !== undefined) {
      if (inText) put(decodeEntities(text));
      continue;
    }
    switch (tag) {
      case 't':
        inText = !closing && !selfClose;
        break;
      case 'tab':
        put('\t');
        break;
      case 'br':
      case 'cr':
        put(cell ? ' ' : '\n');
        break;
      case 'noBreakHyphen':
        put('-');
        break;
      case 'p':
        // Paragraph breaks inside a cell become spaces; elsewhere they are line breaks.
        if (closing) put(cell ? ' ' : '\n');
        break;
      case 'tr':
        if (!closing) row = [];
        else {
          if (row) out.push(row.filter(Boolean).join(' | ') + '\n');
          row = null;
        }
        break;
      case 'tc':
        if (!closing && !selfClose) {
          if (cellDepth === 0) cell = [];
          cellDepth++;
        } else if (closing) {
          cellDepth = Math.max(0, cellDepth - 1);
          if (cellDepth === 0 && cell) {
            const cellText = cell.join('').replace(/\s+/g, ' ').trim();
            if (row) row.push(cellText);
            else out.push(cellText + '\n');
            cell = null;
          }
        }
        break;
    }
  }
  return out.join('');
}

/** A real résumé's XML is well under a megabyte. Anything that inflates far beyond that is a decompression bomb. */
const MAX_PART_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const WANTED_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

export function extractDocx(data: Uint8Array): DocxResult {
  const warnings: string[] = [];
  let files: Record<string, Uint8Array>;
  let oversize = false;
  let total = 0;
  try {
    files = unzipSync(data, {
      // Decide from the declared sizes, before anything is inflated or allocated.
      filter: (f) => {
        if (!WANTED_PARTS.test(f.name)) return false;
        total += f.originalSize;
        if (f.originalSize > MAX_PART_BYTES || total > MAX_TOTAL_BYTES) {
          oversize = true;
          return false;
        }
        return true;
      },
    });
  } catch {
    throw Object.assign(new Error('This DOCX file appears to be corrupted.'), { docCode: 'corrupted' });
  }
  if (oversize) throw Object.assign(new Error('This document expands to an unreasonable size, so it was not opened. Export a normal résumé or paste the text.'), { docCode: 'too_large' });
  const doc = files['word/document.xml'];
  if (!doc) throw Object.assign(new Error('This file is not a valid Word document (word/document.xml is missing).'), { docCode: 'corrupted' });

  // Headers frequently carry the candidate's name and contact line, so they are kept, ahead of the body.
  const parts: string[] = [];
  for (const name of Object.keys(files).sort()) {
    if (/header\d*\.xml$/.test(name)) parts.push(wordXmlToText(strFromU8(files[name])));
  }
  parts.push(wordXmlToText(strFromU8(doc)));
  for (const name of Object.keys(files).sort()) {
    if (/(footer\d*|footnotes|endnotes)\.xml$/.test(name)) parts.push(wordXmlToText(strFromU8(files[name])));
  }
  const text = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n');
  if (/<w:txbxContent/.test(strFromU8(doc))) warnings.push('This document contains text boxes; text inside them was included but its order may differ from the page.');
  return { text, warnings };
}
