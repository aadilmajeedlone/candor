import { strToU8, zipSync } from 'fflate';

/** A run of text placed at an absolute position on a PDF page. */
export interface PdfRun {
  x: number;
  y: number;
  text: string;
  size?: number;
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Build a small but valid single-font PDF (Helvetica) from positioned text runs, one array per page. */
export function makePdf(pages: PdfRun[][]): Uint8Array {
  const objs: string[] = [];
  const add = (body: string): number => objs.push(body);
  add('<< /Type /Catalog /Pages 2 0 R >>'); // 1
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`); // 2
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 3
  pages.forEach((runs, i) => {
    const content = runs.map((r) => `BT /F1 ${r.size ?? 11} Tf ${r.x} ${r.y} Td (${esc(r.text)}) Tj ET`).join('\n');
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

export function makeDocx(opts: { paragraphs: string[]; table?: string[][]; header?: string; footer?: string }): Uint8Array {
  const table = opts.table
    ? `<w:tbl>${opts.table.map((row) => `<w:tr>${row.map((c) => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
    : '';
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${opts.paragraphs.map(p).join('')}${table}</w:body></w:document>`),
  };
  if (opts.header) files['word/header1.xml'] = strToU8(`<?xml version="1.0"?><w:hdr ${W}>${p(opts.header)}</w:hdr>`);
  if (opts.footer) files['word/footer1.xml'] = strToU8(`<?xml version="1.0"?><w:ftr ${W}>${p(opts.footer)}</w:ftr>`);
  return zipSync(files);
}
