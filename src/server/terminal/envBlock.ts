/**
 * Environment block for `CreateProcessW` with `CREATE_UNICODE_ENVIRONMENT` (WP-98/99): `NAME=value\0…\0\0`
 * in UTF-16LE, sorted by name without case like Windows keeps its own block. A name that repeats in
 * another case keeps its first value. Left out: empty names, names with `=` after the first character
 * (`=C:` stays), and anything with NUL.
 */

function isValidEntry(name: string, value: string): boolean {
  return name.length > 0 && !name.includes('\0') && !name.slice(1).includes('=') && !value.includes('\0');
}

/** Ordinal comparison of the upper-case names, the order of `RtlCompareUnicodeString(…, TRUE)`. */
function compareNames(a: string, b: string): number {
  const left = a.toUpperCase();
  const right = b.toUpperCase();
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** The block as UTF-16LE bytes, ready for `lpEnvironment`. */
export function environmentBlock(env: Readonly<Record<string, string | undefined>>): Buffer {
  const seen = new Set<string>();
  const entries: [string, string][] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !isValidEntry(name, value)) continue;
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push([name, value]);
  }
  entries.sort(([a], [b]) => compareNames(a, b));
  const text = entries.length === 0 ? '\0' : entries.map(([name, value]) => `${name}=${value}\0`).join('');
  return Buffer.from(`${text}\0`, 'utf16le');
}
