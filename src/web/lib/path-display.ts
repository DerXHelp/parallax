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

/** Like `pathTail`, but marks a shortened path with a leading `…\` (lists of paths, V1-13). */
export function shortPath(path: string, count = 2): string {
  const tail = pathTail(path, count);
  return tail === path ? path : `…${separatorOf(path)}${tail}`;
}
