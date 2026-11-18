/**
 * Pairing code of "Several computers" (WP-76, docs/wp/WP-76.md §B.7): 128 random bits shown on the
 * sharing computer and typed on the controlling one. Pure (no Node APIs): the server creates the
 * bytes with `crypto.randomBytes`, both sides format and parse here.
 *
 * Format: the 16 bytes as a number v (2 leading zero bits) in Crockford base32 – 26 characters, the
 * first one 0–7 – followed by two check characters (v mod 1021 in base32). 28 characters in 7 groups
 * of 4. 1021 is prime and coprime to 31 and 32, so every single wrong character and every swap of
 * two neighbours is detected before anything goes over the network.
 */

export const PAIRING_CODE_BYTES = 16;
/** Characters without separators (26 data + 2 check). */
export const PAIRING_CODE_CHARS = 28;
export const PAIRING_GROUP_CHARS = 4;
/** A pairing window is open this long (§B.7). */
export const PAIRING_WINDOW_MS = 10 * 60_000;
/** Wrong codes per window before it closes (§B.7). */
export const PAIRING_MAX_FAILURES = 3;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DATA_CHARS = 26;
const CHECK_MODULUS = 1021n;
const VALUE: ReadonlyMap<string, number> = new Map(
  Array.from({ length: ALPHABET.length }, (_, i) => [ALPHABET.charAt(i), i] as const),
);
/** Tolerated look-alikes (Crockford). `U` stays invalid. */
const ALIASES: Readonly<Record<string, string>> = { O: '0', I: '1', L: '1' };

/** Formats 16 bytes as `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`. Throws on another length. */
export function formatPairingCode(bytes: Uint8Array): string {
  if (bytes.length !== PAIRING_CODE_BYTES) throw new RangeError('pairing code must be 16 bytes');
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  const check = Number(value % CHECK_MODULUS);
  const chars: string[] = [];
  for (let i = DATA_CHARS - 1; i >= 0; i -= 1) chars.push(charAt(Number((value >> BigInt(5 * i)) & 31n)));
  chars.push(charAt(check >> 5), charAt(check & 31));
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += PAIRING_GROUP_CHARS) {
    groups.push(chars.slice(i, i + PAIRING_GROUP_CHARS).join(''));
  }
  return groups.join('-');
}

/**
 * Parses a typed code (case-insensitive; spaces and `-` ignored; O → 0, I/L → 1). Null for a wrong
 * length, an unknown character (also `U`), a first character above 7 or wrong check characters.
 */
export function parsePairingCode(input: string): Uint8Array | null {
  // Code units are enough: every non-ASCII character is invalid anyway.
  const upper = input.toUpperCase();
  const chars: string[] = [];
  for (let i = 0; i < upper.length; i += 1) {
    const c = upper.charAt(i);
    if (c !== '-' && c.trim() !== '') chars.push(ALIASES[c] ?? c);
  }
  if (chars.length !== PAIRING_CODE_CHARS) return null;
  const values: number[] = [];
  for (const c of chars) {
    const v = VALUE.get(c);
    if (v === undefined) return null;
    values.push(v);
  }
  const first = values[0];
  const checkHigh = values[DATA_CHARS];
  const checkLow = values[DATA_CHARS + 1];
  if (first === undefined || checkHigh === undefined || checkLow === undefined || first > 7) return null;
  let value = 0n;
  for (const v of values.slice(0, DATA_CHARS)) value = (value << 5n) | BigInt(v);
  if (BigInt(checkHigh * 32 + checkLow) !== value % CHECK_MODULUS) return null;
  const bytes = new Uint8Array(PAIRING_CODE_BYTES);
  for (let i = PAIRING_CODE_BYTES - 1; i >= 0; i -= 1) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

/** Is the input a complete, valid code (for the form's live check)? */
export function isValidPairingCode(input: string): boolean {
  return parsePairingCode(input) !== null;
}

function charAt(index: number): string {
  const c = ALPHABET[index];
  if (c === undefined) throw new RangeError('base32 digit out of range');
  return c;
}
