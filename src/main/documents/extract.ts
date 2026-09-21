import type { DocumentSource } from '@shared/types';
import { normalizeText } from '@shared/util';
import { extractDocx } from './docx';
import { MAX_FILE_BYTES, MAX_PDF_PAGES, MAX_TEXT_CHARS } from './limits';
import { extractPdf } from './pdf';

export type DocumentErrorCode = 'unsupported' | 'corrupted' | 'too_large' | 'empty' | 'scanned' | 'encrypted';

export class DocumentError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}

export interface ExtractedDocument {
  name: string;
  source: DocumentSource;
  text: string;
  pages?: number;
  warnings: string[];
}

export { MAX_FILE_BYTES, MAX_PDF_PAGES, MAX_TEXT_CHARS };

function startsWith(data: Uint8Array, ...sig: number[]): boolean {
  return sig.every((b, i) => data[i] === b);
}

/** Decide the real type from the bytes, not just the file name. */
export function sniffType(name: string, data: Uint8Array): DocumentSource | 'doc' | 'unknown' {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const isPdf = startsWith(data, 0x25, 0x50, 0x44, 0x46, 0x2d) || (data.length > 1024 && new TextDecoder('latin1').decode(data.subarray(0, 1024)).includes('%PDF-'));
  const isZip = startsWith(data, 0x50, 0x4b, 0x03, 0x04);
  const isOle = startsWith(data, 0xd0, 0xcf, 0x11, 0xe0); // legacy .doc
  if (isPdf) return 'pdf';
  if (isOle) return 'doc';
  if (isZip) {
    // A ZIP is a Word document if it says so (extension) or contains the WordprocessingML parts.
    const head = new TextDecoder('latin1').decode(data.subarray(0, Math.min(data.length, 16_384)));
    return ext === 'docx' || ext === 'dotx' || ext === 'docm' || head.includes('word/') ? 'docx' : 'unknown';
  }
  if (ext === 'pdf') return 'pdf'; // declared PDF that lacks the header: let the PDF parser produce the corrupted-file error
  if (['txt', 'md', 'text', 'rtf'].includes(ext) || ext === '') {
    const probe = data.subarray(0, 4096);
    return probe.includes(0) && !hasUtf16Bom(data) ? 'unknown' : 'txt';
  }
  return 'unknown';
}

function hasUtf16Bom(data: Uint8Array): boolean {
  return (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff);
}

export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  const body = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? data.subarray(3) : data;
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(body);
  // Many "text" exports are Windows-1252; if UTF-8 decoding produced replacement characters, try that instead.
  if (utf8.includes('�')) {
    const cp = new TextDecoder('windows-1252').decode(body);
    if (!cp.includes('�')) return cp;
  }
  return utf8;
}

/**
 * Extract normalised text from a résumé / JD file. Validates size and real file type, and turns the failure
 * modes users actually hit (corrupted, scanned, password-protected, legacy .doc) into actionable messages.
 */
export async function extractDocument(name: string, data: Uint8Array): Promise<ExtractedDocument> {
  if (data.byteLength === 0) throw new DocumentError('empty', 'The file is empty.');
  if (data.byteLength > MAX_FILE_BYTES) {
    throw new DocumentError('too_large', `The file is ${(data.byteLength / 1048576).toFixed(1)} MB. The limit is ${MAX_FILE_BYTES / 1048576} MB — export a smaller PDF or paste the text.`);
  }
  const type = sniffType(name, data);
  const warnings: string[] = [];
  let text: string;
  let pages: number | undefined;

  try {
    switch (type) {
      case 'pdf': {
        const r = await extractPdf(data);
        text = r.text;
        pages = r.pages;
        warnings.push(...r.warnings);
        break;
      }
      case 'docx': {
        const r = extractDocx(data);
        text = r.text;
        warnings.push(...r.warnings);
        break;
      }
      case 'txt':
        text = decodeText(data);
        break;
      case 'doc':
        throw new DocumentError('unsupported', 'Legacy .doc files are not supported. Save the document as .docx or PDF and try again.');
      default:
        throw new DocumentError('unsupported', 'Unsupported file type. Use PDF, DOCX or TXT (or paste the text).');
    }
  } catch (err) {
    const code = (err as { docCode?: DocumentErrorCode }).docCode;
    if (code) throw new DocumentError(code, (err as Error).message);
    throw err;
  }

  text = normalizeText(text);
  if (text.length < 20) {
    if (type === 'pdf') throw new DocumentError('scanned', 'No text could be read from this PDF. It looks like a scan or image-only file. Export a text-based PDF, or paste the text (OCR is not built in).');
    throw new DocumentError('empty', 'No readable text was found in this file.');
  }
  if (text.length > MAX_TEXT_CHARS) {
    warnings.push(`The document is very long (${text.length.toLocaleString()} characters); only the first ${MAX_TEXT_CHARS.toLocaleString()} were kept.`);
    text = text.slice(0, MAX_TEXT_CHARS);
  }
  return { name, source: type, text, pages, warnings };
}
