import { describe, expect, it } from 'vitest';
import { DocumentError, MAX_FILE_BYTES, decodeText, extractDocument, sniffType } from '../../src/main/documents/extract';
import { wordXmlToText } from '../../src/main/documents/docx';
import { strToU8, zipSync } from 'fflate';
import { makeDocx, makePdf } from '../helpers/makeDocs';

const enc = (s: string) => new TextEncoder().encode(s);

describe('TXT', () => {
  it('reads UTF-8 with and without BOM, and UTF-16', async () => {
    const t = 'Riya Sharma\nOperations Manager — Northwind Logistics\nManaged 14 agents and cut handling time by 22%.';
    expect((await extractDocument('a.txt', enc(t))).text).toContain('Northwind Logistics');
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(t)]);
    expect((await extractDocument('a.txt', bom)).text.startsWith('Riya')).toBe(true);
    const u16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array([...t].map((c) => c.charCodeAt(0))).buffer)]);
    expect((await extractDocument('a.txt', u16)).text).toContain('cut handling time');
  });

  it('falls back to Windows-1252 for legacy exports', () => {
    const bytes = new Uint8Array([...enc('Caf'), 0xe9, ...enc(' manager, résumé')].filter((_, i, a) => !(i > 4 && a[i] === 0xc3)));
    const s = decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x6d, 0x61, 0x6e, 0x61, 0x67, 0x65, 0x72]));
    expect(s).toBe('Café manager');
    void bytes;
  });

  it('normalises unicode, quotes, dashes and whitespace', async () => {
    const r = await extractDocument('a.txt', enc('“Smart” quotes and – dashes​   with    gaps\n\n\n\nnext paragraph here'));
    expect(r.text).toBe('"Smart" quotes and - dashes with gaps\n\nnext paragraph here');
  });
});

describe('DOCX', () => {
  it('extracts paragraphs, tables, headers and footers', async () => {
    const data = makeDocx({
      header: 'Riya Sharma | riya@example.com',
      paragraphs: ['SUMMARY', 'Operations manager with 7 years of experience &amp; a focus on SLAs.'],
      table: [
        ['Skills', 'SQL, Excel, Power BI'],
        ['Tools', 'Zendesk, Jira'],
      ],
      footer: 'Page 1',
    });
    const r = await extractDocument('cv.docx', data);
    expect(r.source).toBe('docx');
    expect(r.text.startsWith('Riya Sharma')).toBe(true); // header first
    expect(r.text).toContain('experience & a focus on SLAs'); // entity decoded
    expect(r.text).toContain('Skills | SQL, Excel, Power BI');
    expect(r.text).toContain('Tools | Zendesk, Jira');
    expect(r.text).toContain('Page 1');
  });

  it('handles tabs, breaks and unicode in runs', () => {
    const xml = '<w:p><w:r><w:t>Manager</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>2020–Present</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Zürich</w:t></w:r></w:p>';
    expect(wordXmlToText(xml)).toBe('Manager\t2020–Present\nZürich\n');
  });

  it('reports a corrupted DOCX', async () => {
    await expect(extractDocument('cv.docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toMatchObject({ code: 'corrupted' });
  });

  it('refuses a decompression bomb without inflating it', async () => {
    // ~30 MB of XML that compresses to a few kilobytes: small on disk, huge in memory.
    const filler = '<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(900_000);
    const bomb = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${filler}</w:body></w:document>`),
    });
    expect(bomb.byteLength).toBeLessThan(200_000);
    const t0 = performance.now();
    await expect(extractDocument('cv.docx', bomb)).rejects.toMatchObject({ code: 'too_large' });
    expect(performance.now() - t0).toBeLessThan(1500); // rejected from the header, not after inflating
  });
});

describe('PDF', () => {
  it('extracts multi-page text in reading order', async () => {
    const pdf = makePdf([
      [
        { x: 72, y: 740, text: 'Riya Sharma', size: 18 },
        { x: 72, y: 715, text: 'Operations Manager, Northwind Logistics (2020 - Present)' },
        { x: 72, y: 700, text: 'Managed a team of 14 agents; cut handling time by 22%.' },
      ],
      [{ x: 72, y: 740, text: 'Education: B.Com, University of Mumbai, 2015' }],
    ]);
    const r = await extractDocument('cv.pdf', pdf);
    expect(r.source).toBe('pdf');
    expect(r.pages).toBe(2);
    const lines = r.text.split('\n').filter(Boolean);
    expect(lines[0]).toBe('Riya Sharma');
    expect(lines[1]).toContain('Northwind Logistics');
    expect(r.text.indexOf('Managed a team')).toBeLessThan(r.text.indexOf('Education'));
  });

  it('reads a two-column layout column by column', async () => {
    const left = ['EXPERIENCE', 'Operations Manager', 'Northwind Logistics', 'Led 14 agents', 'Cut handling time 22%', 'Built KPI dashboards', 'Managed SLA reporting', 'Coached team leads'];
    const right = ['SKILLS', 'SQL and Excel', 'Power BI', 'Zendesk', 'Jira', 'Process mapping', 'Lean Six Sigma', 'Stakeholder management'];
    const runs = [
      ...left.map((text, i) => ({ x: 50, y: 720 - i * 18, text })),
      ...right.map((text, i) => ({ x: 340, y: 720 - i * 18, text })),
    ];
    const r = await extractDocument('cv.pdf', makePdf([runs]));
    const t = r.text;
    // The whole left column must precede the right column (not interleaved line by line).
    expect(t.indexOf('Coached team leads')).toBeLessThan(t.indexOf('SKILLS'));
    expect(t.indexOf('EXPERIENCE')).toBeLessThan(t.indexOf('Led 14 agents'));
  });

  it('handles a full-width banner above a two-column body, and a two-column block at the bottom of a single-column page', async () => {
    const banner = [{ x: 50, y: 760, text: 'RIYA SHARMA - Operations Manager - riya@example.com - Mumbai, India - a very long header line that spans the page', size: 11 }];
    const sidebar = ['CONTACT', 'Mumbai', 'riya@example.com', 'SKILLS', 'SQL', 'Excel', 'Power BI', 'Zendesk'];
    const main = ['EXPERIENCE', 'Operations Manager, Northwind', 'Led 14 agents across two shifts', 'Cut handling time 22%', 'Built KPI dashboards', 'Coached five team leads', 'Owned SLA reporting', 'Ran vendor reviews'];
    const body = [...sidebar.map((text, i) => ({ x: 40, y: 700 - i * 20, text })), ...main.map((text, i) => ({ x: 300, y: 703 - i * 20, text }))];
    const bottom = [
      { x: 40, y: 400, text: 'A single full-width sentence in the middle of the page that crosses the centre line of the layout entirely.' },
      { x: 40, y: 360, text: 'EDUCATION' },
      { x: 320, y: 360, text: 'RECOGNITION' },
      { x: 40, y: 340, text: 'B.Com, University of Mumbai' },
      { x: 320, y: 340, text: 'Peak Superstar 2023' },
      { x: 40, y: 320, text: 'Class of 2015' },
      { x: 320, y: 320, text: 'Invictus Award' },
    ];
    const t = (await extractDocument('cv.pdf', makePdf([[...banner, ...body], bottom]))).text;
    // Sidebar column is read fully before the main column.
    expect(t.indexOf('Zendesk')).toBeLessThan(t.indexOf('EXPERIENCE'));
    expect(t.indexOf('EXPERIENCE')).toBeLessThan(t.indexOf('Ran vendor reviews'));
    expect(t.startsWith('RIYA SHARMA')).toBe(true);
    // Headings are not glued to the other column.
    expect(t).toMatch(/^EDUCATION$/m);
    expect(t).toMatch(/^RECOGNITION$/m);
    expect(t.indexOf('Class of 2015')).toBeLessThan(t.indexOf('RECOGNITION'));
  });

  it('reports a corrupted PDF', async () => {
    const good = makePdf([[{ x: 72, y: 700, text: 'Some text that is long enough to count' }]]);
    await expect(extractDocument('cv.pdf', good.slice(0, 60))).rejects.toMatchObject({ code: 'corrupted' });
    await expect(extractDocument('cv.pdf', enc('%PDF-1.4\nthis is not really a pdf at all'))).rejects.toMatchObject({ code: 'corrupted' });
  });

  it('reports an image-only (no text) PDF as scanned', async () => {
    const pdf = makePdf([[]]);
    await expect(extractDocument('scan.pdf', pdf)).rejects.toMatchObject({ code: 'scanned' });
  });
});

describe('validation', () => {
  it('rejects unsupported and legacy formats', async () => {
    await expect(extractDocument('cv.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(extractDocument('cv.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(extractDocument('cv.exe', new Uint8Array([0x4d, 0x5a, 0, 0, 0, 0]))).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('rejects empty and oversized files', async () => {
    await expect(extractDocument('a.txt', new Uint8Array(0))).rejects.toMatchObject({ code: 'empty' });
    await expect(extractDocument('a.pdf', new Uint8Array(MAX_FILE_BYTES + 1))).rejects.toMatchObject({ code: 'too_large' });
  });

  it('trusts file contents over the extension', () => {
    expect(sniffType('resume.txt', makePdf([[{ x: 1, y: 1, text: 'x' }]]))).toBe('pdf');
    expect(sniffType('resume.pdf', makeDocx({ paragraphs: ['x'] }))).toBe('docx');
  });

  it('truncates very long documents with a warning', async () => {
    const r = await extractDocument('long.txt', enc('word '.repeat(40_000)));
    expect(r.text.length).toBeLessThanOrEqual(120_000);
    expect(r.warnings.join(' ')).toMatch(/very long/);
  });

  it('DocumentError carries a code', () => {
    expect(new DocumentError('empty', 'x').code).toBe('empty');
  });
});
