/**
 * Display helpers for paths (never used for file access – path rules live in @shared/paths).
 */

function separatorOf(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

/**
 * Last `count` segments of a path for compact display (`D:\1\2\3\4` → `3\4`, Plan "Sidebar").
 * Uses `\` if the path contains one, otherwise `/`. Short paths are returned unchanged.
 */
export function pathTail(path: string, count = 2): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '');
  if (segments.length <= count) return path;
  return segments.slice(-Math.max(1, count)).join(separatorOf(path));
}

/**
 * `pathTail` split for display (WP41-02): `last` = the last segment (the project folder, with a
 * trailing separator if the tail has one), `separator` = the separator run before it, `head` = what
 * comes before (`a\b\c` → `a\b`, `\`, `c`). `head + separator + last === pathTail(path, count)`, so a
 * view can shorten `head` and keep `last` whole. A tail without a separator is all `last`.
 */
export function splitPathTail(path: string, count = 2): { head: string; separator: string; last: string } {
  const tail = pathTail(path, count);
  const isSeparator = (index: number) => {
    const char = tail.charAt(index);
    return char === '\\' || char === '/';
  };
  let end = tail.length;
  while (end > 0 && isSeparator(end - 1)) end--;
  let start = end;
  while (start > 0 && !isSeparator(start - 1)) start--;
  // No separator before the last segment (or no segment at all, e.g. `C:\`): nothing to split.
  if (start === 0 || start === end) return { head: '', separator: '', last: tail };
  let separatorStart = start;
  while (separatorStart > 0 && isSeparator(separatorStart - 1)) separatorStart--;
  return {
    head: tail.slice(0, separatorStart),
    separator: tail.slice(separatorStart, start),
    last: tail.slice(start),
  };
}

/** Like `pathTail`, but marks a shortened path with a leading `…\` (lists of paths, V1-13). */
export function shortPath(path: string, count = 2): string {
  const tail = pathTail(path, count);
  return tail === path ? path : `…${separatorOf(path)}${tail}`;
}
