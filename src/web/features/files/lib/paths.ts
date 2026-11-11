import { isWindowsPathInside, windowsBaseName, windowsPathsEqual } from '@shared/paths';

/**
 * Display helpers for file paths of the files feature (never used for file access – the path rules
 * live in @shared/paths, the server decides what may be read).
 */

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment !== '');
}

/**
 * `path` relative to `root` (`D:\work\sample\src\a.ts` in `D:\work\sample` → `src\a.ts`), keeping
 * the spelling of `path`; null when `root` is null, the path lies outside or equals it.
 */
export function relativeToRoot(path: string, root: string | null): string | null {
  if (root === null || root === '') return null;
  if (!isWindowsPathInside(path, root) || windowsPathsEqual(path, root)) return null;
  return segments(path).slice(segments(root).length).join('\\');
}

/** Folder of a path (`D:\a\b.txt` → `D:\a`, `D:\a.txt` → `D:\`); '' for a drive root or a bare name. */
export function parentPath(path: string): string {
  const parts = segments(path);
  if (parts.length <= 1) return '';
  const parent = parts.slice(0, -1).join('\\');
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/** Name of the file (last segment); the whole path when it has none (drive root). */
export function fileName(path: string): string {
  const name = windowsBaseName(path);
  return name === '' ? path : name;
}
