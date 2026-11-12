import { LIMITS } from '@shared/common';
import { fromGitBashPath, resolveWindowsPath } from '@shared/paths';

/**
 * Pure recognizer of file references in text (WP-55, ADR-141, L15): drive paths (`C:\…`, `C:/…`),
 * Git Bash paths (`/c/…`), `file://` URLs and relative paths with a separator and an extension
 * (`src/a.ts`, `./a.ts`, `..\b.md`), each with an optional `:line[:col]` or `#L12[-L20]` suffix.
 * No DOM, no file system, no commands – it only finds and resolves strings. UNC and device paths
 * (`\\server\share`, `//server/share`, `file://server/…`, `\\?\…`) are recognized but marked
 * `unsafe`: they are never resolved, so nothing can touch them (an fs call would leak the NTLM hash,
 * C.10). Web URLs and e-mail addresses are never references. Rendering (FileLink, `verify`) is the
 * caller's business; this module is shared by every package that shows text.
 */

export type FileRefKind = 'drive' | 'git_bash' | 'file_url' | 'relative' | 'unc' | 'device';

/** Where a reference points to – also the result of `parseFileTarget` (Markdown link targets). */
export interface FileTarget {
  /** Drive, Git Bash and `file://` references: an absolute drive path; relative: as written. */
  path: string;
  line: number | null;
  col: number | null;
  /** Last line of a `#L12-L20` range, else null. */
  endLine: number | null;
  kind: FileRefKind;
  /** UNC/device: recognized but never resolved or linked. */
  unsafe: boolean;
}

export interface FileRef extends FileTarget {
  /** Position in the text: `text.slice(start, end) === raw`. */
  start: number;
  end: number;
  /** The reference as written, including its line suffix. */
  raw: string;
}

/** Characters that end a reference token (besides whitespace): quotes, list separators, glob/shell signs. */
const TOKEN = /[^\s,;"'`<>|*?«»‹›“”„‘’]+/gu;
/** Any URL with a scheme (`file://` is handled, the rest is excluded). */
const URL_PATTERN = /(?<![\p{L}\p{N}])([A-Za-z][A-Za-z0-9+.-]*):\/\/[^\s<>"'`]*/gu;
const WWW_PATTERN = /(?<![\p{L}\p{N}.])www\.[^\s<>"'`]*/giu;
const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
/** `:12`, `:12:4`, `#L12`, `#L12C4`, `#L12-L20`. */
const LINE_SUFFIX = /(?::(\d{1,7})(?::(\d{1,7}))?|#L(\d{1,7})(?:C(\d{1,7}))?(?:-L?(\d{1,7})(?:C\d{1,7})?)?)$/;
const DRIVE = /^[A-Za-z]:[\\/]/;
const DRIVE_INSIDE = /(?<![\p{L}\p{N}_])[A-Za-z]:[\\/]/u;
const DEVICE = /^(?:[\\/]{2}[?.][\\/]|[\\/]\?\?[\\/])/;
/** Device paths in running text – their `?` would otherwise split the token (`\\?\C:\x` → `C:\x`). */
const DEVICE_PATTERN = /(?:[\\/]{2}[?.][\\/]|\\\?\?\\)[^\s<>"'`|*]*/g;
const UNC = /^[\\/]{2}[\p{L}\p{N}_$-]/u;
const GIT_BASH = /^\/[A-Za-z]\/[^\\/]/;
/** One segment of a relative path. */
const SEGMENT = String.raw`[\p{L}\p{N}_.@+~$%()\[\]-]+`;
const RELATIVE = new RegExp(String.raw`^(?:\.{1,2}[\\/])*(?:${SEGMENT}[\\/])*${SEGMENT}$`, 'u');
/** The last segment carries an extension with at least one letter (`a.ts`, not `1.5`, not `.env`). */
const EXTENSION = /[^\\/.][^\\/]*\.[\p{L}\p{N}]*\p{L}[\p{L}\p{N}]*$/u;
const KEY_PREFIX = /^[\p{L}\p{N}_.-]+=(?=\S)/u;
const OPENERS = new Set(['(', '[', '{']);
const TRAILING = new Set(['.', ',', ':', ';', '!']);
const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}

/** Drops trailing punctuation and closing brackets without an opening one in the token. */
function trimEnd(token: string): string {
  let value = token;
  for (;;) {
    const last = value.at(-1);
    if (last === undefined) return value;
    const opener = CLOSERS[last];
    if (TRAILING.has(last) || (opener !== undefined && count(value, opener) < count(value, last))) {
      value = value.slice(0, -1);
      continue;
    }
    return value;
  }
}

function positive(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

interface Suffixed {
  body: string;
  line: number | null;
  col: number | null;
  endLine: number | null;
}

function splitSuffix(value: string): Suffixed {
  const match = LINE_SUFFIX.exec(value);
  if (match === null) return { body: value, line: null, col: null, endLine: null };
  const line = positive(match[1] ?? match[3]);
  return {
    body: value.slice(0, match.index),
    line,
    col: line === null ? null : positive(match[2] ?? match[4]),
    endLine: line === null ? null : positive(match[5]),
  };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Kind and normalized path of a reference body (without suffix); null when it is no path. */
function classify(
  body: string,
  relativeNeedsExtension: boolean,
): Pick<FileTarget, 'path' | 'kind' | 'unsafe'> | null {
  if (DEVICE.test(body)) return { path: body, kind: 'device', unsafe: true };
  if (UNC.test(body)) return { path: body, kind: 'unc', unsafe: true };
  if (DRIVE.test(body)) return body.length > 3 ? { path: body, kind: 'drive', unsafe: false } : null;
  if (GIT_BASH.test(body)) {
    const path = fromGitBashPath(body);
    return path === null ? null : { path, kind: 'git_bash', unsafe: false };
  }
  // Rooted without a drive, home/environment prefixes (`~/`, `$HOME/`, `%TEMP%\`) – unknown bases.
  if (/^[\\/~$%]/.test(body) || !RELATIVE.test(body)) return null;
  const segments = body.split(/[\\/]/);
  // Windows drops a trailing dot of a name – such a "segment" is prose (`e.g./i.e.`), not a path.
  if (segments.some((segment) => segment !== '.' && segment !== '..' && segment.endsWith('.'))) return null;
  if (relativeNeedsExtension && (segments.length < 2 || !EXTENSION.test(body))) return null;
  if (!/[^\\/.]/.test(body)) return null;
  return { path: body, kind: 'relative', unsafe: false };
}

/** `file:///C:/x`, `file://localhost/C:/x` → drive path; `file://host/share` → unsafe UNC. */
function classifyFileUrl(rest: string): Pick<FileTarget, 'path' | 'kind' | 'unsafe'> | null {
  const decoded = decode(rest);
  const local = /^(?:\/|localhost\/)([A-Za-z]:[\\/].*)$/i.exec(decoded);
  if (local !== null) {
    const path = local[1] ?? '';
    return path.length > 3 ? { path, kind: 'file_url', unsafe: false } : null;
  }
  if (/^[A-Za-z]:[\\/]./.test(decoded)) return { path: decoded, kind: 'file_url', unsafe: false };
  const host = /^([^/\\]+)[/\\]/.exec(decoded);
  if (host === null || /^localhost$/i.test(host[1] ?? '')) return null;
  return { path: `\\\\${decoded.replace(/\//g, '\\')}`, kind: 'unc', unsafe: true };
}

function deviceTarget(path: string): FileTarget {
  return { path, line: null, col: null, endLine: null, kind: 'device', unsafe: true };
}

function makeRef(text: string, start: number, end: number, target: FileTarget): FileRef {
  return { ...target, start, end, raw: text.slice(start, end) };
}

/** A `file://` URL in running text (the scheme match covers it up to whitespace). */
function fileUrlRef(text: string, start: number, match: string): FileRef | null {
  const value = trimEnd(match);
  const { body, line, col, endLine } = splitSuffix(value);
  const target = classifyFileUrl(body.slice('file://'.length));
  if (target === null) return null;
  return makeRef(text, start, start + value.length, { ...target, line, col, endLine });
}

/** One token of running text (between delimiters); null when it holds no reference. */
function tokenRef(text: string, tokenStart: number, token: string): FileRef | null {
  let offset = 0;
  while (offset < token.length && OPENERS.has(token.charAt(offset))) offset++;
  const key = KEY_PREFIX.exec(token.slice(offset));
  if (key !== null) offset += key[0].length;
  let value = token.slice(offset);
  if (!DRIVE.test(value) && !DEVICE.test(value) && !UNC.test(value) && !GIT_BASH.test(value)) {
    // A drive path after a prefix that is no path (`→C:\x`, `at:C:\x`).
    const inside = DRIVE_INSIDE.exec(value);
    if (inside !== null && inside.index > 0 && !RELATIVE.test(value)) {
      offset += inside.index;
      value = value.slice(inside.index);
    }
  }
  value = trimEnd(value);
  if (value === '' || value.length > LIMITS.pathChars) return null;
  const { body, line, col, endLine } = splitSuffix(value);
  const target = classify(body, true);
  if (target === null) return null;
  const start = tokenStart + offset;
  return makeRef(text, start, start + value.length, { ...target, line, col, endLine });
}

/** Replaces the matches of `pattern` with spaces (same length, so offsets stay valid). */
function mask(text: string, pattern: RegExp, onMatch?: (match: string, index: number) => void): string {
  let out = '';
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    onMatch?.(match[0], match.index);
    out += text.slice(position, match.index) + ' '.repeat(match[0].length);
    position = match.index + match[0].length;
  }
  return out + text.slice(position);
}

/**
 * Every file reference of `text`, in order and without overlaps. Positions refer to `text`.
 * Never throws; texts without a separator return quickly.
 */
export function findFileRefs(text: string): FileRef[] {
  if (!/[\\/]/.test(text)) return [];
  const refs: FileRef[] = [];
  let working = mask(text, URL_PATTERN, (match, index) => {
    if (!/^file:\/\//i.test(match)) return;
    const ref = fileUrlRef(text, index, match);
    if (ref !== null) refs.push(ref);
  });
  working = mask(working, DEVICE_PATTERN, (match, index) => {
    const value = trimEnd(match);
    if (value.length > 4) refs.push(makeRef(text, index, index + value.length, deviceTarget(value)));
  });
  working = mask(working, WWW_PATTERN);
  working = mask(working, EMAIL_PATTERN);
  for (const token of working.matchAll(TOKEN)) {
    const ref = tokenRef(text, token.index, token[0]);
    if (ref !== null) refs.push(ref);
  }
  return refs.sort((a, b) => a.start - b.start);
}

/**
 * The absolute Windows path of a reference: relative ones against `cwd` (null without one), the
 * others only normalized (`/` → `\`, `..` resolved). Null for unsafe references and for every
 * result that fails the C.10 filter (`resolveWindowsPath`).
 */
export function resolveFileRef(
  ref: Pick<FileTarget, 'path' | 'kind' | 'unsafe'>,
  cwd: string | null,
): string | null {
  if (ref.unsafe) return null;
  if (ref.kind === 'relative') return cwd === null ? null : resolveWindowsPath(cwd, ref.path);
  return resolveWindowsPath(ref.path, ref.path);
}

/**
 * The target of a Markdown link (`[text](target)`) when it is local: a drive path, a Git Bash path,
 * `file:///C:/…` or a relative path (no extension needed – a link is explicit); `#L12`/`:12` give
 * the line, another fragment or a query is dropped. Link destinations come percent-encoded (`\` →
 * `%5C`) and are decoded first. Null for web URLs, other schemes, anchors and rooted paths;
 * `file://host/…` and UNC targets come back `unsafe`.
 */
export function parseFileTarget(target: string): FileTarget | null {
  let value = decode(target.trim());
  if (value === '' || value.length > LIMITS.pathChars) return null;
  const fileUrl = /^file:\/\/(.*)$/i.exec(value);
  if (fileUrl === null && /^[A-Za-z][A-Za-z0-9+.-]+:/.test(value)) return null;
  if (value.startsWith('#') || value.startsWith('?')) return null;
  const query = value.indexOf('?');
  if (query > 0 && fileUrl === null) value = value.slice(0, query);
  const { body, line, col, endLine } = splitSuffix(value);
  const hash = body.indexOf('#');
  const path = hash >= 0 ? body.slice(0, hash) : body;
  const kind = fileUrl === null ? classify(path, false) : classifyFileUrl(path.slice('file://'.length));
  return kind === null ? null : { ...kind, line, col, endLine };
}

/**
 * The absolute path of a path string from a tool input or a tool result (`file_path`, Grep/Glob
 * hits): drive and Git Bash paths are normalized, relative ones resolved against `cwd`; UNC, device
 * and rooted paths without a drive give null.
 */
export function resolveFilePath(path: string, cwd: string | null): string | null {
  const value = path.trim();
  if (value === '' || value.length > LIMITS.pathChars) return null;
  if (DRIVE.test(value)) return resolveWindowsPath(value, value);
  const bash = GIT_BASH.test(value) ? fromGitBashPath(value) : null;
  if (bash !== null) return resolveWindowsPath(bash, bash);
  if (/^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) return null;
  return cwd === null ? null : resolveWindowsPath(cwd, value);
}
