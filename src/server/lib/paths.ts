import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { makeError } from '@shared/errors';
import { isWindowsPathInside, windowsPathIssue } from '@shared/paths';
import { CommandError } from '../sync/ports';

/**
 * File system checks on top of the pure Windows path rules in `@shared/paths` (C.10, ADR-017).
 * The rules themselves (UNC, device, ADS, reserved names, …) live ONLY in `@shared/paths`.
 * Every function rejects unsafe strings before touching the file system (an `fs.stat` on a UNC
 * path would leak the NTLM hash) – and, since R1-17 (WP-33), also paths that run through a
 * junction or symlink whose target is unsafe (`assertNoUnsafeLink`).
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

async function checkLinks(file: string, fs: LinkFs, budget: { hops: number }): Promise<void> {
  const root = file.slice(0, 3);
  let current = root;
  for (const segment of file.slice(3).split(/[\\/]/)) {
    if (segment === '') continue;
    current = path.win32.join(current, segment);
    let isLink: boolean;
    try {
      isLink = (await fs.lstat(current)).isSymbolicLink();
    } catch (error) {
      const code = fsErrorCode(error);
      // The rest does not exist (or is no folder): the caller's own access reports that.
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw error;
    }
    if (!isLink) continue;
    budget.hops -= 1;
    if (budget.hops < 0) throw linkTargetRejected();
    let raw: string;
    try {
      raw = await fs.readlink(current);
    } catch {
      // A reparse point Node cannot read (e.g. a cloud placeholder or volume mount): fail closed.
      throw linkTargetRejected();
    }
    const target = resolveLinkTarget(current, raw);
    if (target === null) throw linkTargetRejected();
    // The target's own segments may be links too – check them before anything goes through it.
    await checkLinks(target, fs, budget);
  }
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

/**
 * Allowlist check for file access (B "Datei- und Editor-Sicherheit": realpath before the
 * allowlist): rejects unsafe strings and paths through unsafe links (R1-17, before `realpath`
 * follows them), resolves `path` (symlinks, junctions) and requires the result to lie inside one
 * of the (resolved) `roots`. Returns the resolved path.
 * Errors: PATH_REJECTED (unsafe string, unsafe link or unsafe resolution), PATH_NOT_ALLOWED
 * (outside), CWD_NOT_FOUND is not used here – a missing file rejects with the fs error (ENOENT).
 */
export async function resolveAllowedPath(
  file: string,
  roots: readonly string[],
  fs: LinkFs = nodeLinkFs,
): Promise<string> {
  assertSafePath(file);
  for (const root of roots) assertSafePath(root);
  await assertNoUnsafeLink(file, fs);
  const resolved = await realpath(file);
  // A junction or symlink may point to a UNC/device path: check the resolved string again.
  assertSafePath(resolved);
  for (const root of roots) {
    let resolvedRoot: string;
    try {
      await assertNoUnsafeLink(root, fs);
      resolvedRoot = await realpath(root);
    } catch {
      continue;
    }
    if (isWindowsPathInside(resolved, resolvedRoot)) return resolved;
  }
  throw new CommandError(makeError('PATH_NOT_ALLOWED'));
}
