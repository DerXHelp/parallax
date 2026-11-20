/**
 * Pure path rules (C.10, B "cwd exakt behalten"; R0-02, ADR-017): the ONE implementation of the
 * UNC/device/ADS filter and of the case-insensitive comparison on Windows, and since WP-102 of the
 * POSIX rules (Linux, WP-100 E6). No Node APIs.
 * Server code uses it through src/server/lib/paths.ts (WP-10 adds the fs-based checks); WP-11 and
 * the web import it directly. Nobody re-implements these rules.
 * Keys are only for comparing and grouping – a stored `cwd` is never replaced by its key.
 *
 * Which rules apply is a property of the HOST, not of the process that looks at a path: a Windows
 * window shows the sessions of a Linux server. `pathRules(pathFlavorOf(hostState.platform))` picks
 * the set; the `windows*` functions stay the win32 implementation.
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
  /** POSIX (WP-102): `/proc`, `/sys`, `/dev` or below – kernel files and devices, never project files. */
  'pseudo_fs',
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

/** Longest name of one folder or file (NTFS: 255 UTF-16 units per segment). */
export const NAME_MAX_CHARS = 255;

/**
 * WP-94: the first reason why `name` cannot be the name of a new folder (one segment, no
 * separators), or null. The rules of `windowsPathIssue` for one segment; a separator or `:` is
 * `invalid_char` (a name never contains a path or a stream). No trimming: callers trim the input.
 */
export function windowsNameIssue(name: string): PathIssue | null {
  if (name === '') return 'empty';
  if (name.length > NAME_MAX_CHARS) return 'too_long';
  if (/[\\/:]/.test(name)) return 'invalid_char';
  return windowsPathIssue(`C:\\${name}`);
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

// ---- POSIX (Linux, WP-100 E6, WP-102) ----

/** Linux `PATH_MAX` (bytes, UTF-8, without the terminating NUL). */
export const POSIX_PATH_MAX_BYTES = 4095;
/** Linux `NAME_MAX` (bytes per segment, UTF-8). */
export const POSIX_NAME_MAX_BYTES = 255;
/** Kernel file systems and devices: never a project folder, never read as a file (FIFOs and devices block). */
const POSIX_PSEUDO_ROOTS = ['/proc', '/sys', '/dev'] as const;

/** UTF-8 length of `text` in bytes (no TextEncoder: src/shared has neither DOM nor Node types). */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * C.10 for POSIX: the first reason why `path` must be rejected before ANY file system access, or
 * null for a plain absolute path (`/home/u/x`). Case-sensitive; every character but control
 * characters is allowed (`:` `?` `*` `"`, trailing dots and `CON` are ordinary names on Linux).
 * Pure string check – no resolution; symlinks are the caller's business (lib/paths.ts).
 */
export function posixPathIssue(path: string): PathIssue | null {
  if (path === '') return 'empty';
  if (path.length > POSIX_PATH_MAX_BYTES || utf8Bytes(path) > POSIX_PATH_MAX_BYTES) return 'too_long';
  if (hasControlChar(path)) return 'control_char';
  if (!path.startsWith('/')) return 'not_absolute';
  for (const segment of path.split('/')) {
    if (segment === '') continue;
    if (segment === '.' || segment === '..') return 'dot_segment';
    if (utf8Bytes(segment) > POSIX_NAME_MAX_BYTES) return 'too_long';
  }
  const key = posixPathKey(path);
  if (POSIX_PSEUDO_ROOTS.some((root) => key === root || key.startsWith(`${root}/`))) return 'pseudo_fs';
  return null;
}

export function isSafePosixPath(path: string): boolean {
  return posixPathIssue(path) === null;
}

/** WP-94 for POSIX: the first reason why `name` cannot be the name of a new folder, or null. */
export function posixNameIssue(name: string): PathIssue | null {
  if (name === '') return 'empty';
  if (utf8Bytes(name) > POSIX_NAME_MAX_BYTES) return 'too_long';
  if (hasControlChar(name)) return 'control_char';
  if (name.includes('/')) return 'invalid_char';
  if (name === '.' || name === '..') return 'dot_segment';
  return null;
}

/** Comparison key: repeated `/` collapsed, trailing `/` removed except for the root. CASE-SENSITIVE. */
export function posixPathKey(path: string): string {
  const key = path.replace(/\/+/g, '/');
  return key.length > 1 && key.endsWith('/') ? key.slice(0, -1) : key;
}

export function posixPathsEqual(a: string, b: string): boolean {
  return posixPathKey(a) === posixPathKey(b);
}

/** True if `child` equals `parent` or lies below it (by key; callers pass resolved paths). */
export function isPosixPathInside(child: string, parent: string): boolean {
  const c = posixPathKey(child);
  const p = posixPathKey(parent);
  return c === p || c.startsWith(p === '/' ? '/' : `${p}/`);
}

/**
 * `relative` (`.`/`..` allowed) against the absolute `base`; an absolute `relative` is only
 * normalized. Repeated `/` collapse. Null if `base` is not safe, the result would leave the root
 * or the RESULT has a PATH_ISSUE. No `~` expansion (the caller knows the home folder).
 */
export function resolvePosixPath(base: string, relative: string): string | null {
  let segments: string[];
  if (relative.startsWith('/')) {
    segments = [];
  } else {
    if (posixPathIssue(base) !== null) return null;
    segments = base.split('/').filter((segment) => segment !== '');
  }
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const result = `/${segments.join('/')}`;
  return posixPathIssue(result) === null ? result : null;
}

/** Last segment (`/a/b.txt` → `b.txt`; trailing `/` ignored; root → ''). */
export function posixBaseName(path: string): string {
  return (
    path
      .split('/')
      .filter((segment) => segment !== '')
      .at(-1) ?? ''
  );
}

/** Lower-case extension without the dot ('' if none; `a.tar.gz` → 'gz', `.gitignore` → ''). */
export function posixPathExtension(path: string): string {
  const name = posixBaseName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

// ---- Rule sets (WP-102) ----

/** Which path rules apply: a property of the host (`HostState.platform`), see the file comment. */
export type PathFlavor = 'win32' | 'posix';

/** `process.platform` / `HostState.platform` → rule set: `win32` is Windows, everything else POSIX. */
export function pathFlavorOf(platform: string): PathFlavor {
  return platform === 'win32' ? 'win32' : 'posix';
}

/** The path rules of one flavor – callers hold one of these instead of calling `windows*`/`posix*` directly. */
export interface PathRules {
  readonly flavor: PathFlavor;
  /** Separator used when building paths (`\` on Windows; `/` is accepted there too). */
  readonly separator: '\\' | '/';
  /** Longest path in the unit of the flavor (UTF-16 units on Windows, UTF-8 bytes on POSIX). */
  readonly maxLength: number;
  /** C.10: why the path must not be touched, or null. */
  issue(path: string): PathIssue | null;
  isSafe(path: string): boolean;
  /** WP-94: why `name` cannot be a new folder's name, or null. */
  nameIssue(name: string): PathIssue | null;
  /** Comparison key (case-insensitive on Windows, case-sensitive on POSIX). */
  key(path: string): string;
  equal(a: string, b: string): boolean;
  isInside(child: string, parent: string): boolean;
  resolve(base: string, relative: string): string | null;
  baseName(path: string): string;
  extension(path: string): string;
  /** `dir` + `name` with exactly one separator between them (no resolution, no checks). */
  join(dir: string, name: string): string;
  /** Syntactically absolute for this flavor (`C:\…` resp. `/…`), nothing else checked. */
  isAbsolute(path: string): boolean;
}

function joinWith(separator: '\\' | '/'): (dir: string, name: string) => string {
  const trailing = separator === '\\' ? /[\\/]+$/ : /\/+$/;
  const leading = separator === '\\' ? /^[\\/]+/ : /^\/+/;
  return (dir, name) => `${dir.replace(trailing, '')}${separator}${name.replace(leading, '')}`;
}

export const WIN32_PATHS: PathRules = {
  flavor: 'win32',
  separator: '\\',
  maxLength: PATH_MAX_CHARS,
  issue: windowsPathIssue,
  isSafe: isSafeWindowsPath,
  nameIssue: windowsNameIssue,
  key: windowsPathKey,
  equal: windowsPathsEqual,
  isInside: isWindowsPathInside,
  resolve: resolveWindowsPath,
  baseName: windowsBaseName,
  extension: windowsPathExtension,
  join: joinWith('\\'),
  isAbsolute: (path) => /^[A-Za-z]:[\\/]/.test(path),
};

export const POSIX_PATHS: PathRules = {
  flavor: 'posix',
  separator: '/',
  maxLength: POSIX_PATH_MAX_BYTES,
  issue: posixPathIssue,
  isSafe: isSafePosixPath,
  nameIssue: posixNameIssue,
  key: posixPathKey,
  equal: posixPathsEqual,
  isInside: isPosixPathInside,
  resolve: resolvePosixPath,
  baseName: posixBaseName,
  extension: posixPathExtension,
  join: joinWith('/'),
  isAbsolute: (path) => path.startsWith('/'),
};

export function pathRules(flavor: PathFlavor): PathRules {
  return flavor === 'win32' ? WIN32_PATHS : POSIX_PATHS;
}
