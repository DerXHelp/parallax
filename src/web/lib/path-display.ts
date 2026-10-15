/**
 * Display helpers for paths (never used for file access – path rules live in @shared/paths).
 */

/**
 * Last `count` segments of a path for compact display (`D:\1\2\3\4` → `3\4`, Plan "Sidebar").
 * Uses `\` if the path contains one, otherwise `/`. Short paths are returned unchanged.
 */
export function pathTail(path: string, count = 2): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '');
  if (segments.length <= count) return path;
  const separator = path.includes('\\') ? '\\' : '/';
  return segments.slice(-Math.max(1, count)).join(separator);
}
