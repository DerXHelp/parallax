/**
 * Tolerant reader for ONE top-level string field of a streamed, still incomplete JSON object
 * (`tool_call.inputPartial` – the raw `input_json_delta` text, ADR-148): the plan panel shows the
 * `content` of a running `Write` on the plan file while Claude types it. Never throws; anything it
 * cannot read yet is `null`. Pure.
 */

export interface PartialString {
  /** Decoded text up to the current end (`\n`, `\"`, `\\`, `\uXXXX` … resolved; a cut escape is dropped). */
  value: string;
  /** The closing quote arrived. */
  complete: boolean;
}

interface Scanned extends PartialString {
  /** Index after the closing quote (or the end of the input when incomplete). */
  end: number;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

const HEX4 = /^[0-9a-fA-F]{4}$/;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Decodes a JSON string body starting right after its opening quote. Stops at the closing quote or
 * at the end of the input; an escape cut by the end (`\`, `\u00`, a high surrogate without its
 * pair yet) is left out, so the text never shows half an escape.
 */
function scanString(source: string, start: number): Scanned {
  const parts: string[] = [];
  let index = start;
  let run = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      parts.push(source.slice(run, index));
      return { value: parts.join(''), complete: true, end: index + 1 };
    }
    if (char !== '\\') {
      index++;
      continue;
    }
    parts.push(source.slice(run, index));
    const escape = source[index + 1];
    if (escape === undefined) return { value: parts.join(''), complete: false, end: source.length };
    if (escape !== 'u') {
      // Unknown escapes are kept as the character itself (lenient, never an error).
      parts.push(SIMPLE_ESCAPES[escape] ?? escape);
      index += 2;
      run = index;
      continue;
    }
    const hex = source.slice(index + 2, index + 6);
    if (hex.length < 4) return { value: parts.join(''), complete: false, end: source.length };
    if (!HEX4.test(hex)) {
      // Malformed \u escape: skip the two characters and go on.
      index += 2;
      run = index;
      continue;
    }
    const code = Number.parseInt(hex, 16);
    if (isHighSurrogate(code)) {
      const next = source.slice(index + 6, index + 12);
      if (next.length < 6 && '\\u'.startsWith(next.slice(0, 2)) && /^[0-9a-fA-F]*$/.test(next.slice(2))) {
        // The low surrogate may still come: wait for it.
        return { value: parts.join(''), complete: false, end: source.length };
      }
      const low =
        next.startsWith('\\u') && HEX4.test(next.slice(2)) ? Number.parseInt(next.slice(2), 16) : null;
      if (low !== null && isLowSurrogate(low)) {
        parts.push(String.fromCharCode(code, low));
        index += 12;
        run = index;
        continue;
      }
    }
    parts.push(String.fromCharCode(code));
    index += 6;
    run = index;
  }
  parts.push(source.slice(run, index));
  return { value: parts.join(''), complete: false, end: source.length };
}

function skipWhitespace(source: string, index: number): number {
  let position = index;
  while (position < source.length && /\s/.test(source.charAt(position))) position++;
  return position;
}

/** Index after a complete JSON value starting at `start`, or -1 while it is still incomplete. */
function skipValue(source: string, start: number): number {
  const first = source[start];
  if (first === '"') {
    const scanned = scanString(source, start + 1);
    return scanned.complete ? scanned.end : -1;
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    let index = start;
    while (index < source.length) {
      const char = source[index];
      if (char === '"') {
        const scanned = scanString(source, index + 1);
        if (!scanned.complete) return -1;
        index = scanned.end;
        continue;
      }
      if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) return index + 1;
      }
      index++;
    }
    return -1;
  }
  // Number, true, false, null: up to the next delimiter (complete only when one follows).
  let index = start;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === ',' || char === '}' || /\s/.test(char)) return index;
    index++;
  }
  return -1;
}

/**
 * The string value of the top-level key `field` in the partial JSON object `partial`, as far as it
 * arrived; null when the key did not arrive yet, its value is no string or the text is no object.
 * Values of other keys are skipped (a `"content"` inside another string never matches).
 */
export function partialJsonString(partial: string, field: string): PartialString | null {
  let index = skipWhitespace(partial, 0);
  if (partial[index] !== '{') return null;
  index++;
  for (;;) {
    index = skipWhitespace(partial, index);
    const char = partial[index];
    if (char === undefined || char === '}') return null;
    if (char === ',') {
      index++;
      continue;
    }
    if (char !== '"') return null;
    const key = scanString(partial, index + 1);
    if (!key.complete) return null;
    index = skipWhitespace(partial, key.end);
    if (partial[index] !== ':') return null;
    index = skipWhitespace(partial, index + 1);
    if (index >= partial.length) return null;
    if (key.value === field) {
      if (partial[index] !== '"') return null;
      const scanned = scanString(partial, index + 1);
      return { value: scanned.value, complete: scanned.complete };
    }
    const end = skipValue(partial, index);
    if (end < 0) return null;
    index = end;
  }
}
