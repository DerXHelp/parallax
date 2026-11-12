import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { makeError } from '@shared/errors';
import { isWindowsPathInside, windowsPathIssue, windowsPathKey } from '@shared/paths';
import { CommandError } from '../sync/ports';
import { FsTimeoutError } from './fsTimeout';

/**
 * File system checks on top of the pure Windows path rules in `@shared/paths` (C.10, ADR-017).
 * The rules themselves (UNC, device, ADS, reserved names, …) live ONLY in `@shared/paths`.
 * Every function rejects unsafe strings before touching the file system (an `fs.stat` on a UNC
 * path would leak the NTLM hash) – and, since R1-17 (WP-33), also paths that run through a
 * junction or symlink whose target is unsafe (`assertNoUnsafeLink`). Phase 3 (WP-53, ADR-141):
 * `resolveAllowedPath` is THE access check of the file service (commands, GET /api/file, "open in").
 */

/** Throws `CommandError(PATH_REJECTED, {reason})` if `path` must not be touched. */
export function assertSafePath(path: string): void {
  const reason = windowsPathIssue(path);
  if (reason !== null) throw new CommandError(makeError('PATH_REJECTED', { reason }));
}

/** `code` of a Node fs error (`ENOENT`, `EPERM`, …), or null for anything else. */
export function fsErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}

// ---- links (R1-17) ----

/** The two calls `assertNoUnsafeLink` needs (seam for tests: a UNC symlink needs admin rights). */
export interface LinkFs {
  /** Never follows the last segment (junctions and symlinks report `isSymbolicLink()`). */
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  /** Target of a junction/symlink as stored (absolute, or relative to the link's folder). */
  readlink(path: string): Promise<string>;
}

export const nodeLinkFs: LinkFs = {
  lstat: (file) => lstat(file),
  readlink: (file) => readlink(file),
};

/** Links followed per check (chains, loops); more → `link_target`. */
export const MAX_LINK_HOPS = 16;

/** The `PATH_REJECTED {reason: 'link_target'}` error of an unsafe link. */
export function linkTargetRejected(): CommandError {
  return new CommandError(makeError('PATH_REJECTED', { reason: 'link_target' }));
}

/**
 * Absolute target of the link `link` (as stored by `readlink`): a plain relative target is
 * resolved against the link's folder (pure string operation), everything else must already be an
 * absolute drive path. Null if the target must not be touched (`windowsPathIssue`: UNC, device,
 * `\foo`, `C:foo`, …).
 */
export function resolveLinkTarget(link: string, target: string): string | null {
  const plainRelative = target !== '' && !/^[\\/]/.test(target) && !/^[A-Za-z]:/.test(target);
  const candidate = plainRelative ? path.win32.resolve(path.win32.dirname(link), target) : target;
  return windowsPathIssue(candidate) === null ? candidate : null;
}

/**
 * Walks `file` segment by segment and returns where it physically leads (every link replaced by
 * its checked target), or null when a segment does not exist. R4-10: after a link the walk goes on
 * in its TARGET – a relative target further down (`..\..\z`) is resolved against the folder it
 * really lies in, like the file system does, not against the path as written.
 */
async function checkLinks(file: string, fs: LinkFs, budget: { hops: number }): Promise<string | null> {
  // Paths with `.`/`..` segments never get here (windowsPathIssue rejects them).
  let current = file.slice(0, 3);
  for (const segment of file.slice(3).split(/[\\/]/)) {
    if (segment === '') continue;
    current = path.win32.join(current, segment);
    let isLink: boolean;
    try {
      isLink = (await fs.lstat(current)).isSymbolicLink();
    } catch (error) {
      const code = fsErrorCode(error);
      // The rest does not exist (or is no folder): the caller's own access reports that.
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw error;
    }
    if (!isLink) continue;
    budget.hops -= 1;
    if (budget.hops < 0) throw linkTargetRejected();
    let raw: string;
    try {
      raw = await fs.readlink(current);
    } catch (error) {
      // A hanging drive stays a timeout (ADR-141), not a rejected link.
      if (error instanceof FsTimeoutError) throw error;
      // A reparse point Node cannot read (e.g. a cloud placeholder or volume mount): fail closed.
      throw linkTargetRejected();
    }
    const target = resolveLinkTarget(current, raw);
    if (target === null) throw linkTargetRejected();
    // The target's own segments may be links too – check them before anything goes through it;
    // the remaining segments continue in the target (R4-10).
    const physical = await checkLinks(target, fs, budget);
    if (physical === null) return null;
    current = physical;
  }
  return current;
}

/**
 * R1-17: `lstat` on every segment of `path` (the drive root excluded); for a junction/symlink its
 * target (`readlink`, resolved by `resolveLinkTarget`) must be a safe drive path and is checked
 * the same way, at most `MAX_LINK_HOPS` links. Otherwise `CommandError(PATH_REJECTED, {reason:
 * 'link_target'})` – before any call follows the link (a symlink to `\\server\share` would leak
 * the NTLM hash, C.10). Unsafe strings throw `PATH_REJECTED {reason}` first; a missing segment
 * ends the check (the caller's access reports ENOENT); other fs errors are rethrown.
 */
export async function assertNoUnsafeLink(file: string, fs: LinkFs = nodeLinkFs): Promise<void> {
  assertSafePath(file);
  await checkLinks(file, fs, { hops: MAX_LINK_HOPS });
}

/**
 * Checks a session working directory (architecture §5.2): safe path, no unsafe link on the way
 * (R1-17), exists, is a directory. The string is never normalized or resolved – callers store it
 * exactly as given (B).
 */
export async function checkCwd(cwd: string, fs: LinkFs = nodeLinkFs): Promise<void> {
  assertSafePath(cwd);
  let isDirectory: boolean;
  try {
    await assertNoUnsafeLink(cwd, fs);
    isDirectory = (await stat(cwd)).isDirectory();
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new CommandError(makeError('CWD_NOT_FOUND'));
    throw error;
  }
  if (!isDirectory) throw new CommandError(makeError('CWD_NOT_DIRECTORY'));
}

// ---- access check (B "Datei- und Editor-Sicherheit"; Phase 3: ADR-141, WP-53) ----

/** The fs calls of the access check (seam: tests count calls, fake links, hang a call). */
export interface AccessFs extends LinkFs {
  /** Native realpath: links resolved, 8.3 names expanded, on-disk case. */
  realpath(path: string): Promise<string>;
}

export const nodeAccessFs: AccessFs = {
  ...nodeLinkFs,
  realpath: (file) => realpath(file),
};

/** A folder whose contents may be read; `kind` names the access (e.g. `FileInfo.access`). */
export interface AccessRoot<K extends string> {
  path: string;
  kind: K;
}

/** A set of `windowsPathKey`s (only `has` is needed: a Map of the index works as well). */
export type PathKeySet = Pick<ReadonlySet<string>, 'has'>;

export interface AccessPolicy<K extends string> {
  /** In priority order (the first root that contains the target names the access). Unsafe strings are ignored, never touched. */
  roots: readonly AccessRoot<K>[];
  /**
   * Single files allowed besides the roots (session file index, ADR-145): `windowsPathKey`s,
   * loaded only when a path is not below a root.
   */
  listed?: { kind: K; keys: () => Promise<PathKeySet> };
}

export interface AccessOptions {
  fs?: AccessFs;
  /**
   * Physical path of a root (after links), null if it is missing or unsafe. Callers may cache it
   * (the file service: per entry, 60 s). Default: `physicalPath` on every call.
   */
  resolveRoot?: (root: string) => Promise<string | null>;
}

export interface AllowedPath<K extends string> {
  /** Physical path (realpath; a mapped network drive keeps its letter). */
  realPath: string;
  access: K;
}

function pathNotAllowed(): CommandError {
  return new CommandError(makeError('PATH_NOT_ALLOWED'));
}

/**
 * An fs failure of the access check as the file error of the contract (ADR-141): ENOENT/ENOTDIR →
 * FILE_NOT_FOUND, EACCES/EPERM → FILE_NOT_READABLE {reason: 'access'}, EBUSY → {reason: 'busy'},
 * a timeout (FsTimeoutError) → {reason: 'timeout'}, other fs codes → {reason: <code>}.
 * CommandErrors and non-fs errors are returned unchanged.
 */
export function fileAccessError(error: unknown): unknown {
  if (error instanceof CommandError) return error;
  if (error instanceof FsTimeoutError) {
    return new CommandError(makeError('FILE_NOT_READABLE', { reason: 'timeout' }));
  }
  const code = fsErrorCode(error);
  if (code === null) return error;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new CommandError(makeError('FILE_NOT_FOUND'));
  if (code === 'EACCES' || code === 'EPERM') {
    return new CommandError(makeError('FILE_NOT_READABLE', { reason: 'access' }));
  }
  if (code === 'EBUSY') return new CommandError(makeError('FILE_NOT_READABLE', { reason: 'busy' }));
  return new CommandError(makeError('FILE_NOT_READABLE', { reason: code.toLowerCase() }));
}

/**
 * Steps 3 and 4 of the check chain: `lstat`/`readlink` on every segment (an unsafe link target →
 * PATH_REJECTED {reason: 'link_target'}), then `realpath` and the string filter on the result.
 * A mapped network drive (ADR-119/141: a drive letter counts as local) makes realpath name its
 * share (`\\server\share\…`); the segment walk has proved that no link on the way leads there, so
 * the walked drive path stands. Any other unsafe result → PATH_REJECTED {reason}. fs failures are
 * mapped by `fileAccessError`.
 */
export async function physicalPath(file: string, fs: AccessFs = nodeAccessFs): Promise<string> {
  assertSafePath(file);
  let walked: string | null;
  let resolved: string;
  try {
    walked = await checkLinks(file, fs, { hops: MAX_LINK_HOPS });
    resolved = await fs.realpath(file);
  } catch (error) {
    throw fileAccessError(error);
  }
  const issue = windowsPathIssue(resolved);
  if (issue === null) return resolved;
  if (issue === 'unc' && walked !== null) return walked;
  throw new CommandError(makeError('PATH_REJECTED', { reason: issue }));
}

/** `physicalPath` of a root, or null if the root is unsafe, missing or unreadable. */
export async function physicalRoot(root: string, fs: AccessFs = nodeAccessFs): Promise<string | null> {
  if (windowsPathIssue(root) !== null) return null;
  try {
    return await physicalPath(root, fs);
  } catch {
    return null;
  }
}

/**
 * THE access check for files (ADR-141; commands, GET /api/file and "open in" all call it), in
 * exactly this order:
 *  1. string filter (`windowsPathIssue`) → PATH_REJECTED {reason};
 *  2. policy on the REQUESTED string: below a root (by key) or listed → otherwise PATH_NOT_ALLOWED
 *     before ANY file system call (no SMB attempt for a path from model text, L15);
 *  3. `lstat`/`readlink` per segment (unsafe link target → PATH_REJECTED {reason: 'link_target'});
 *  4. `realpath` + string filter on the target (`physicalPath`);
 *  5. policy on the TARGET: inside a root's physical path, or the target itself is listed →
 *     otherwise PATH_NOT_ALLOWED (a link inside the project must not lead out of it).
 * fs failures: FILE_NOT_FOUND / FILE_NOT_READABLE (`fileAccessError`; timeouts come from the
 * caller's `fs`, see lib/fsTimeout.ts).
 */
export async function resolveAllowedPath<K extends string>(
  file: string,
  policy: AccessPolicy<K>,
  options: AccessOptions = {},
): Promise<AllowedPath<K>> {
  assertSafePath(file);
  const fs = options.fs ?? nodeAccessFs;
  const roots = policy.roots.filter((root) => windowsPathIssue(root.path) === null);
  let listedKeys: PathKeySet | null = null;
  const listed = async (): Promise<PathKeySet> => {
    listedKeys ??= policy.listed === undefined ? new Set<string>() : await policy.listed.keys();
    return listedKeys;
  };
  // Step 2: nothing below this line may run for a path the policy does not name.
  if (
    !roots.some((root) => isWindowsPathInside(file, root.path)) &&
    !(await listed()).has(windowsPathKey(file))
  ) {
    throw pathNotAllowed();
  }
  const realPath = await physicalPath(file, fs);
  const resolveRoot = options.resolveRoot ?? ((root: string) => physicalRoot(root, fs));
  for (const root of roots) {
    const physical = await resolveRoot(root.path);
    if (physical !== null && isWindowsPathInside(realPath, physical)) return { realPath, access: root.kind };
  }
  if (policy.listed !== undefined && (await listed()).has(windowsPathKey(realPath))) {
    return { realPath, access: policy.listed.kind };
  }
  throw pathNotAllowed();
}
