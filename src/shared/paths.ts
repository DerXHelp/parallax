/**
 * Pure Windows path rules (C.10, B "cwd exakt behalten"; R0-02, ADR-017): the ONE implementation
 * of the UNC/device/ADS filter and of the case-insensitive comparison. No Node APIs.
 * Server code uses it through src/server/lib/paths.ts (WP-10 adds the fs-based checks); WP-11 and
 * the web import it directly. Nobody re-implements these rules.
 * Keys are only for comparing and grouping – a stored `cwd` is never replaced by its key.
 */

/** Why a path must not be touched (`PATH_REJECTED` with `params.reason`). */
export const PATH_ISSUES = [
  'empty',
  'too_long',
  'control_char',
  /** `\\server\share`, `//server/share` – an fs call would leak the NTLM hash (C.10). */
  'unc',
  /** `\\?\…`, `\\.\…`, `\??\…`. */
  'device',
  /** Not `<drive>:\…` (relative, `\foo`, `C:foo`, `/c/…`). */
  'not_absolute',
  /** A `:` after the drive letter (alternate data stream). */
  'ads',
  /** `<`, `>`, `"`, `|`, `?`, `*`. */
  'invalid_char',
  /** `.` or `..` segment (paths must already be resolved). */
  'dot_segment',
  /** Segment ending with `.` or space (Windows strips them silently). */
  'trailing_dot_or_space',
  /** CON, PRN, AUX, NUL, COM0–9, LPT0–9, CONIN$, CONOUT$, CLOCK$ – also with an extension. */
  'reserved_name',
] as const;
export type PathIssue = (typeof PATH_ISSUES)[number];

/** Windows long-path limit (UTF-16 units). */
export const PATH_MAX_CHARS = 32_767;

const RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;
const INVALID_CHARS = /[<>"|?*]/;

function hasControlChar(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/**
 * C.10: the first reason why `path` must be rejected before ANY file system access, or null for a
 * plain absolute drive path (`C:\work\x`, `D:/work/x`). Pure string check – no resolution.
 */
export function windowsPathIssue(path: string): PathIssue | null {
  if (path === '') return 'empty';
  if (path.length > PATH_MAX_CHARS) return 'too_long';
  if (hasControlChar(path)) return 'control_char';
  if (/^[\\/][\\/][?.][\\/]/.test(path) || /^[\\/]\?\?[\\/]/.test(path)) return 'device';
  if (/^[\\/][\\/]/.test(path)) return 'unc';
  if (!/^[A-Za-z]:[\\/]/.test(path)) return 'not_absolute';
  const rest = path.slice(3);
  if (rest.includes(':')) return 'ads';
  if (INVALID_CHARS.test(rest)) return 'invalid_char';
  for (const segment of rest.split(/[\\/]/)) {
    if (segment === '') continue;
    if (segment === '.' || segment === '..') return 'dot_segment';
    if (segment.endsWith('.') || segment.endsWith(' ')) return 'trailing_dot_or_space';
    const base = (segment.split('.')[0] ?? '').trimEnd();
    if (RESERVED_NAME.test(base)) return 'reserved_name';
  }
  return null;
}

export function isSafeWindowsPath(path: string): boolean {
  return windowsPathIssue(path) === null;
}

/**
 * Comparison key (B: "Vergleiche und Gruppierung case-insensitiv"): lower case, `/` → `\`,
 * repeated separators collapsed, trailing separator removed except for a drive root (`c:\`).
 */
export function windowsPathKey(path: string): string {
  const key = path.toLowerCase().replace(/[\\/]+/g, '\\');
  if (key.length > 3 && key.endsWith('\\')) return key.slice(0, -1);
  if (/^[a-z]:$/.test(key)) return `${key}\\`;
  return key;
}

export function windowsPathsEqual(a: string, b: string): boolean {
  return windowsPathKey(a) === windowsPathKey(b);
}

/** True if `child` equals `parent` or lies below it (by key; callers pass resolved paths). */
export function isWindowsPathInside(child: string, parent: string): boolean {
  const c = windowsPathKey(child);
  const p = windowsPathKey(parent);
  return c === p || c.startsWith(p.endsWith('\\') ? p : `${p}\\`);
}

// ---- Phase 3 (WP-50 §4.7): helpers for file references – pure string work, no resolution ----

/** `/c/Users/x` (Git Bash/MSYS) → `C:\Users\x`; null if the path is not of that form. */
export function fromGitBashPath(path: string): string | null {
  const match = /^\/([A-Za-z])(?:\/(.*))?$/.exec(path);
  if (match === null) return null;
  const drive = (match[1] ?? '').toUpperCase();
  const rest = (match[2] ?? '').replace(/\//g, '\\');
  return `${drive}:\\${rest}`;
}

/**
 * `relative` (separators `/` or `\`, `.`/`..` allowed) against the absolute `base`; an absolute
 * drive path is only normalized. Separators become `\`, repeated separators collapse. Null if
 * `base` is not a safe absolute path, the result would leave the drive root, `relative` is rooted
 * without a drive (`\x`, `C:x`) or the RESULT has a PATH_ISSUE (C.10 applies to the result).
 */
export function resolveWindowsPath(base: string, relative: string): string | null {
  let drive: string;
  let segments: string[];
  if (/^[A-Za-z]:[\\/]/.test(relative)) {
    drive = relative.slice(0, 2);
    segments = [];
    relative = relative.slice(3);
  } else if (/^[\\/]/.test(relative) || /^[A-Za-z]:/.test(relative)) {
    return null;
  } else {
    if (windowsPathIssue(base) !== null) return null;
    drive = base.slice(0, 2);
    segments = base
      .slice(3)
      .split(/[\\/]+/)
      .filter((segment) => segment !== '');
  }
  for (const segment of relative.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const result = `${drive}\\${segments.join('\\')}`;
  return windowsPathIssue(result) === null ? result : null;
}

/** Last segment (`C:\a\b.txt` → `b.txt`; trailing separators ignored; drive root → ''). */
export function windowsBaseName(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '');
  const last = segments.at(-1) ?? '';
  return /^[A-Za-z]:$/.test(last) ? '' : last;
}

/** Lower-case extension without the dot ('' if none; `a.tar.gz` → 'gz', `.gitignore` → ''). */
export function windowsPathExtension(path: string): string {
  const name = windowsBaseName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}
