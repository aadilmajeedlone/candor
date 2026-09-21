/**
 * Getting a JSON object out of what a language model actually wrote.
 *
 * A model asked for "one JSON object" still sometimes answers with markdown fences, a friendly sentence before or
 * after, single quotes, trailing commas, a raw line break inside a string, an unescaped quote, a missing comma, or — the
 * case that broke Preparation — a reply that simply stops in the middle because it ran out of output budget. This
 * module handles all of those without ever throwing, without a "first { to last }" regex (braces inside strings and
 * nested objects break that), and without inventing content: a repair only changes punctuation, and a cut-off reply is
 * salvaged by keeping the values that were written completely and dropping the rest.
 *
 * Pure and synchronous: no I/O, no logging, safe to run on any string.
 */

export type ExtractFailure = 'empty' | 'no-json' | 'truncated' | 'invalid';

export interface ExtractedObject {
  value: Record<string, unknown>;
  /** Where it came from: the whole reply, a markdown code fence, or somewhere inside other text. */
  how: 'direct' | 'fenced' | 'embedded';
  /** Punctuation fixes that were needed (empty when the text was already valid JSON). */
  repairs: string[];
}

export interface Salvage {
  /** What was written in full before the reply stopped. Nothing here was invented or completed. */
  value: Record<string, unknown>;
  /** Top-level keys whose values were completed. */
  completeKeys: string[];
  /** The top-level key that was being written when the reply stopped, if any (its list may be partly present in `value`). */
  partialKey?: string;
}

export interface Extraction {
  /** Every top-level object found that parsed, in order of appearance. */
  objects: ExtractedObject[];
  /** Why nothing usable was found (set only when `objects` is empty). */
  failure?: ExtractFailure;
  /** A short, safe description of what was wrong. Never contains the reply's content. */
  detail: string;
  /** An object was opened and the reply ended before it closed. */
  truncated: boolean;
  /** For a truncated reply: the part that was written completely. */
  salvage?: Salvage;
}

/** Larger than any reply the app asks for; beyond this the text is not scanned at all. */
const MAX_INPUT = 1_500_000;
/** Bound on how many `{` positions are tried, so pathological input cannot make the scan quadratic. */
const MAX_STARTS = 300;

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
/** What can follow the `{` that opens an object: a key (quoted or bare), or an immediate `}`. */
const OBJECT_START = /^\s*(?:["'}]|[A-Za-z_$][\w$-]*\s*:)/;

/** Find JSON objects in a model reply. Never throws. */
export function extractJsonObjects(input: string): Extraction {
  const text = typeof input === 'string' ? input.replace(ZERO_WIDTH, '').trim() : '';
  if (text === '') return { objects: [], failure: 'empty', detail: 'the reply was empty', truncated: false };
  if (text.length > MAX_INPUT) return { objects: [], failure: 'invalid', detail: 'the reply was far larger than expected', truncated: false };

  // Fast path: the whole reply is the JSON object.
  const direct = parseStrict(text);
  if (direct) return { objects: [{ value: direct, how: 'direct', repairs: [] }], detail: 'ok', truncated: false };

  let truncated = false;
  let salvage: Salvage | undefined;
  let invalid: string | undefined;

  const sources: { text: string; how: 'fenced' | 'embedded' }[] = [];
  for (const fenced of fencedBlocks(text)) sources.push({ text: fenced, how: 'fenced' });
  sources.push({ text, how: 'embedded' });

  for (const src of sources) {
    const found = scanSource(src.text, src.how);
    if (found.objects.length > 0) return { objects: found.objects, detail: 'ok', truncated: false };
    if (found.invalid) invalid ??= found.invalid;
    if (found.truncated) {
      truncated = true;
      salvage ??= found.salvage;
    }
  }

  if (truncated) return { objects: [], failure: 'truncated', detail: 'the reply ended before the JSON object was finished', truncated: true, salvage };
  if (invalid) return { objects: [], failure: 'invalid', detail: invalid, truncated: false };
  return { objects: [], failure: 'no-json', detail: 'the reply contained no JSON object', truncated: false };
}

/**
 * Compatibility wrapper: the first object found, or an Error describing why there was none. New code should use
 * `extractJsonObjects` and look at `truncated`, `salvage` and `failure`.
 */
export function extractJson(text: string): unknown {
  const ex = extractJsonObjects(text);
  const first = ex.objects[0];
  if (first) return first.value;
  throw new Error(ex.failure === 'truncated' ? 'unterminated JSON object' : ex.failure === 'no-json' || ex.failure === 'empty' ? 'no JSON object found' : ex.detail);
}

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

/** Contents of markdown code fences, including one that was never closed because the reply was cut off. */
function fencedBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```[ \t]*(?:jsonc?|json5|JSON)?[ \t]*\r?\n?([\s\S]*?)(?:```|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined && m[1].includes('{')) out.push(m[1]);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

interface SourceScan {
  objects: ExtractedObject[];
  truncated: boolean;
  salvage?: Salvage;
  invalid?: string;
}

function scanSource(source: string, how: 'fenced' | 'embedded'): SourceScan {
  const objects: ExtractedObject[] = [];
  let invalid: string | undefined;
  let starts = 0;
  let i = 0;
  while ((i = source.indexOf('{', i)) !== -1 && starts++ < MAX_STARTS) {
    if (!OBJECT_START.test(source.slice(i + 1, i + 200))) {
      i++; // a brace in ordinary prose, such as "{name}"
      continue;
    }
    const scan = scanObject(source, i);
    if (!scan.complete) {
      // The text ended inside this object. Everything after it is part of it, so nothing later can be a separate answer.
      if (objects.length > 0) break;
      return { objects, truncated: true, salvage: salvageOf(scan), invalid };
    }
    const parsed = parseStrict(scan.text);
    if (parsed) {
      const spansAll = i === 0 && source.slice(scan.end).trim() === '';
      objects.push({ value: parsed, how: how === 'embedded' && spansAll ? 'direct' : how, repairs: scan.repairs });
    } else invalid ??= 'a JSON object was found but it could not be read';
    i = scan.end; // skip the whole span: its inner objects are parts of it, not separate answers
  }
  return { objects, truncated: false, invalid };
}

/* ------------------------------------------------------------------ */
/* A tolerant scanner                                                  */
/* ------------------------------------------------------------------ */

interface SafePoint {
  /** Length of the repaired text right after a value that was written in full. */
  len: number;
  /** Open containers at that point ('{' or '['), outermost first. */
  stack: string;
  /** Top-level keys completed so far. */
  keys: string[];
}

interface Scan {
  /** The object closed. */
  complete: boolean;
  /** Index in the source just past the closing brace (complete) or the end of the source (incomplete). */
  end: number;
  /** The scanned text with mechanical repairs applied. */
  text: string;
  repairs: string[];
  /** Places where a value had just been completed, for salvaging a reply that stopped early. */
  safe: SafePoint[];
}

const isSpace = (c: string): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t';
const LITERAL_FIXES: Record<string, string> = { True: 'true', False: 'false', None: 'null', NaN: 'null', Infinity: 'null', '-Infinity': 'null', undefined: 'null' };
const isCommentStart = (src: string, i: number): boolean => src[i] === '/' && (src[i + 1] === '/' || src[i + 1] === '*');

/**
 * Read one object starting at `start` (which is a '{'), repairing punctuation as it goes:
 *  - trailing and repeated commas, a missing comma before the next key, comments
 *  - raw control characters and line breaks inside strings
 *  - single-quoted strings and unquoted keys
 *  - a double quote inside a string that is not followed by `,` `}` `]` `:` (an unescaped quote in prose)
 *  - a bracket that was never closed before its parent was
 *  - Python/JS literals (True, None, NaN…)
 * and remembering every point where a value had just been completed, so a reply that stops early can be cut back there.
 */
function scanObject(src: string, start: number): Scan {
  const out: string[] = [];
  let outLen = 0;
  const emit = (s: string): void => {
    out.push(s);
    outLen += s.length;
  };
  const repairs = new Set<string>();
  const stack: string[] = []; // '{' or '['
  const modes: ('key' | 'value')[] = []; // for each open '{': is the next string a key or a value?
  const safe: SafePoint[] = [];
  const topKeys: string[] = [];
  let currentKey: string | undefined;
  let afterValue = false; // a value has just been completed in the current container
  const finish = (complete: boolean, end: number): Scan => ({ complete, end, text: out.join(''), repairs: [...repairs], safe });
  /** A value just ended: at depth 1 that completes a top-level key. */
  const valueDone = (): void => {
    if (stack.length === 1 && currentKey !== undefined) {
      topKeys.push(currentKey);
      currentKey = undefined;
    }
    afterValue = true;
    safe.push({ len: outLen, stack: stack.join(''), keys: topKeys.slice() });
  };
  const commaBeforeKey = (): void => {
    emit(',');
    modes[modes.length - 1] = 'key';
    afterValue = false;
    repairs.add('inserted a missing comma');
  };

  const n = src.length;
  let i = start;
  while (i < n) {
    const c = src[i];

    // ---- strings (double or single quoted)
    if (c === '"' || c === "'") {
      const inObject = stack[stack.length - 1] === '{';
      if (inObject && modes[modes.length - 1] === 'value' && afterValue) commaBeforeKey(); // {"a": 1 "b": 2}
      const isKey = inObject && modes[modes.length - 1] === 'key';
      const read = readString(src, i, c, isKey);
      for (const r of read.repairs) repairs.add(r);
      if (!read.closed) return finish(false, n); // the reply ended inside a string: it cannot be trusted or completed
      emit(read.text);
      i = read.next;
      if (isKey) {
        if (stack.length === 1) currentKey = read.value;
        afterValue = false;
      } else {
        valueDone();
        if (read.missingComma && inObject) commaBeforeKey(); // {"a": "x" "b": "y"}
      }
      continue;
    }

    // ---- structure
    if (c === '{' || c === '[') {
      const inObject = stack[stack.length - 1] === '{';
      if (inObject && modes[modes.length - 1] === 'value' && afterValue) {
        // a value followed by another value with no key between them: cannot be repaired
        return finish(false, n);
      }
      emit(c);
      stack.push(c);
      if (c === '{') modes.push('key');
      afterValue = false;
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      const want = c === '}' ? '{' : '[';
      if (!stack.includes(want)) {
        repairs.add('ignored a stray closing bracket');
        i++;
        continue;
      }
      // close whatever was left open inside it (a list that never ended before its object did)
      while (stack[stack.length - 1] !== want) {
        const open = stack.pop() as string;
        if (open === '{') modes.pop();
        emit(open === '{' ? '}' : ']');
        repairs.add('closed a bracket that was left open');
        valueDone();
      }
      emit(c);
      stack.pop();
      if (want === '{') modes.pop();
      i++;
      if (stack.length === 0) return finish(true, i);
      valueDone();
      continue;
    }
    if (c === ':') {
      emit(':');
      if (stack[stack.length - 1] === '{') modes[modes.length - 1] = 'value';
      afterValue = false;
      i++;
      continue;
    }
    if (c === ',') {
      // A comma that only leads to a closing bracket, or to another comma, is a mistake: drop it.
      let j = i + 1;
      while (j < n && (isSpace(src[j]) || isCommentStart(src, j))) j = isCommentStart(src, j) ? skipComment(src, j) : j + 1;
      const nx = src[j];
      if (nx === '}' || nx === ']' || nx === ',') {
        repairs.add(nx === ',' ? 'removed a repeated comma' : 'removed a trailing comma');
        i++;
        continue;
      }
      emit(',');
      if (stack[stack.length - 1] === '{') modes[modes.length - 1] = 'key';
      afterValue = false;
      i++;
      continue;
    }
    if (isSpace(c)) {
      emit(c);
      i++;
      continue;
    }
    if (isCommentStart(src, i)) {
      repairs.add('removed a comment');
      i = skipComment(src, i);
      continue;
    }

    // ---- bare tokens: numbers, true/false/null, or (repaired) literals and unquoted keys
    let j = i;
    while (j < n && !isSpace(src[j]) && ',:{}[]"\''.indexOf(src[j]) === -1 && !isCommentStart(src, j)) j++;
    if (j === i) {
      i++; // an unexpected character: skip it rather than loop
      continue;
    }
    const token = src.slice(i, j);
    const inObject = stack[stack.length - 1] === '{';
    if (inObject && modes[modes.length - 1] === 'key') {
      repairs.add('quoted a key');
      emit(JSON.stringify(token));
      if (stack.length === 1) currentKey = token;
      afterValue = false;
      i = j;
      continue;
    }
    if (j >= n) {
      emit(token); // the reply ended in the middle of a bare token (a number cut short?): not a safe cut point
      return finish(false, n);
    }
    if (token in LITERAL_FIXES) {
      repairs.add('replaced a non-JSON literal');
      emit(LITERAL_FIXES[token]);
    } else emit(token);
    i = j;
    valueDone();
  }
  return finish(false, n);
}

/** Skip a `//` or block comment starting at i; returns the index after it. */
function skipComment(src: string, i: number): number {
  if (src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl + 1;
  }
  const close = src.indexOf('*/', i + 2);
  return close === -1 ? src.length : close + 2;
}

interface StringRead {
  closed: boolean;
  /** The string as valid JSON, including its quotes. */
  text: string;
  /** The string's value. */
  value: string;
  /** Index after the closing quote. */
  next: number;
  /** The next thing is another key, so a comma was left out. */
  missingComma: boolean;
  repairs: string[];
}

/** Does a quoted key followed by a colon start at `k`? Used to tell "a comma was forgotten" from "a quote in the text". */
function keyAhead(src: string, k: number): boolean {
  if (src[k] !== '"') return false;
  let j = k + 1;
  while (j < src.length && src[j] !== '"') {
    if (src[j] === '\\') j++;
    else if (src[j] === '\n') return false;
    j++;
  }
  j++;
  while (j < src.length && isSpace(src[j])) j++;
  return src[j] === ':';
}

const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/', "'": "'" };

/**
 * Read a string starting at `i` (which is its opening quote). A quote inside the string that is not followed by
 * `,` `}` `]` (or `:` for a key, or the end of the text) is treated as part of the text and escaped, because that is what
 * an unescaped quote in a sentence looks like; a real closing quote is always followed by one of those.
 */
function readString(src: string, i: number, quote: string, isKey: boolean): StringRead {
  const repairs: string[] = [];
  let value = '';
  let j = i + 1;
  const n = src.length;
  while (j < n) {
    const c = src[j];
    if (c === '\\') {
      const e = src[j + 1];
      if (e === undefined) break; // a lone backslash at the very end
      if (e === 'u') {
        const hex = src.slice(j + 2, j + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          value += String.fromCharCode(parseInt(hex, 16));
          j += 6;
          continue;
        }
        if (j + 6 > n) break; // cut off inside a unicode escape
        repairs.push('dropped a broken escape');
        j += 2;
        continue;
      }
      if (e in SIMPLE_ESCAPES) {
        if (e === "'") repairs.push('unescaped an apostrophe');
        value += SIMPLE_ESCAPES[e];
        j += 2;
        continue;
      }
      repairs.push('dropped a broken escape');
      value += e; // "\x" → "x"
      j += 2;
      continue;
    }
    if (c === quote) {
      let k = j + 1;
      while (k < n && isSpace(src[k])) k++;
      const nx = src[k];
      const closes = nx === undefined || (isKey ? nx === ':' : nx === ',' || nx === '}' || nx === ']') || isCommentStart(src, k);
      const missingComma = !isKey && nx === '"' && k > j + 1 && keyAhead(src, k);
      if (closes || missingComma) {
        if (quote === "'") repairs.push('converted single quotes');
        return { closed: true, text: JSON.stringify(value), value, next: j + 1, missingComma, repairs };
      }
      repairs.push('escaped a quote inside a string');
      value += c;
      j++;
      continue;
    }
    if (c < ' ') {
      repairs.push('escaped a line break or control character inside a string');
      value += c;
      j++;
      continue;
    }
    value += c;
    j++;
  }
  return { closed: false, text: '', value, next: n, missingComma: false, repairs };
}

/* ------------------------------------------------------------------ */
/* Salvage                                                             */
/* ------------------------------------------------------------------ */

/**
 * Cut a reply that stopped early back to the last point where a value had just been written in full, and close whatever
 * was open. Only complete values survive: a string that was cut in the middle is dropped, and a list keeps the items that
 * were finished. A cut inside an item that is itself an object, or inside an object that is a value, is not used: half an
 * item is not an item.
 */
function salvageOf(scan: Scan): Salvage | undefined {
  for (let s = scan.safe.length - 1; s >= 0; s--) {
    const point = scan.safe[s];
    if (point.stack !== '{' && point.stack !== '{[') continue;
    const head = scan.text.slice(0, point.len);
    const closers = [...point.stack].reverse().map((o) => (o === '{' ? '}' : ']')).join('');
    const parsed = parseStrict(head + closers);
    if (!parsed) continue;
    const completeKeys = point.keys.filter((k) => k in parsed);
    // Inside a nested list or object, the last top-level key in the salvaged object is the one that was cut.
    const last = Object.keys(parsed).pop();
    const partialKey = point.stack.length > 1 && last !== undefined && !completeKeys.includes(last) ? last : undefined;
    return { value: parsed, completeKeys, partialKey };
  }
  return undefined;
}

function parseStrict(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
