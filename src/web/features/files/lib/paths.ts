import { WIN32_PATHS, type PathRules } from '@shared/paths';

/**
 * Display helpers for file paths of the files feature (never used for file access – the path rules
 * live in @shared/paths, the server decides what may be read). WP-104: `rules` = the path rules of
 * the session's host (default Windows).
 */

function segments(path: string, rules: PathRules): string[] {
  return path.split(rules.flavor === 'win32' ? /[\\/]+/ : /\/+/).filter((segment) => segment !== '');
}

/**
 * `path` relative to `root` (`D:\work\sample\src\a.ts` in `D:\work\sample` → `src\a.ts`; on Linux
 * `/w/s/src/a.ts` in `/w/s` → `src/a.ts`), keeping the spelling of `path`; null when `root` is null,
 * the path lies outside or equals it.
 */
export function relativeToRoot(
  path: string,
  root: string | null,
  rules: PathRules = WIN32_PATHS,
): string | null {
  if (root === null || root === '') return null;
  if (!rules.isInside(path, root) || rules.equal(path, root)) return null;
  return segments(path, rules).slice(segments(root, rules).length).join(rules.separator);
}

/**
 * Folder of a path (`D:\a\b.txt` → `D:\a`, `D:\a.txt` → `D:\`; `/a/b.txt` → `/a`, `/a.txt` → `/`);
 * '' for a root or a bare name.
 */
export function parentPath(path: string, rules: PathRules = WIN32_PATHS): string {
  const parts = segments(path, rules);
  if (rules.flavor === 'posix') {
    if (parts.length === 0 || !path.startsWith('/')) return '';
    return `/${parts.slice(0, -1).join('/')}`;
  }
  if (parts.length <= 1) return '';
  const parent = parts.slice(0, -1).join('\\');
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/** Name of the file (last segment); the whole path when it has none (a root). */
export function fileName(path: string, rules: PathRules = WIN32_PATHS): string {
  const name = rules.baseName(path);
  return name === '' ? path : name;
}
