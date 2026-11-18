/**
 * Host ids and colors of new computers (docs/wp/WP-75.md §4.3): the id is a slug of the display
 * name (`hostIdSchema`, also the key purpose `coupling:<hostId>`), unique in the list and never
 * `local`; the color is the first one of HOST_COLORS no computer uses yet.
 */
import { LOCAL_HOST_ID, hostIdSchema, type HostId } from '@shared/common';
import { HOST_COLORS, type HostColor } from '@shared/model';

/** Longest host id (`hostIdSchema`: 1 + 31 characters). */
const HOST_ID_CHARS = 32;
const FALLBACK = 'host';

/** Characters NFKD does not decompose into a base letter. */
const LETTERS: Readonly<Record<string, string>> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd' };

/** Lower-case ASCII slug of `name` (`a-z`, `0-9`, single `-`), at most `max` characters; may be ''. */
export function slugify(name: string, max = HOST_ID_CHARS): string {
  const ascii = name
    .toLowerCase()
    .replace(/[ßæœøłđ]/gu, (char) => LETTERS[char] ?? '-')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');
  return ascii
    .replace(/[^a-z0-9]+/gu, '-')
    .slice(0, max)
    .replace(/^-+|-+$/gu, '');
}

/** A host id for `name` that is not in `taken` (`name-2`, `name-3` … when needed). */
export function uniqueHostId(name: string, taken: ReadonlySet<string>): HostId {
  const base = slugify(name) || FALLBACK;
  const free = (id: string): boolean =>
    id !== LOCAL_HOST_ID && !taken.has(id) && hostIdSchema.safeParse(id).success;
  if (free(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${String(n)}`;
    const stem = (slugify(base, HOST_ID_CHARS - suffix.length) || FALLBACK).replace(/-+$/u, '');
    const id = `${stem}${suffix}`;
    if (free(id)) return id;
  }
}

/** The first color no computer uses; when all are taken, the next one in turn. */
export function pickColor(used: readonly HostColor[]): HostColor {
  const free = HOST_COLORS.find((color) => !used.includes(color));
  return free ?? HOST_COLORS[used.length % HOST_COLORS.length] ?? 'blue';
}
