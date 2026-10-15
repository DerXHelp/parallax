import { realpath, stat } from 'node:fs/promises';
import { makeError } from '@shared/errors';
import { isWindowsPathInside, windowsPathIssue } from '@shared/paths';
import { CommandError } from '../sync/ports';

/**
 * File system checks on top of the pure Windows path rules in `@shared/paths` (C.10, ADR-017).
 * The rules themselves (UNC, device, ADS, reserved names, …) live ONLY in `@shared/paths`.
 * Every function rejects unsafe strings before touching the file system (an `fs.stat` on a UNC
 * path would leak the NTLM hash).
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

/**
 * Checks a session working directory (architecture §5.2): safe path, exists, is a directory.
 * The string is never normalized or resolved – callers store it exactly as given (B).
 */
export async function checkCwd(cwd: string): Promise<void> {
  assertSafePath(cwd);
  let isDirectory: boolean;
  try {
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
 * allowlist): rejects unsafe strings, resolves `path` (symlinks, junctions) and requires the
 * result to lie inside one of the (resolved) `roots`. Returns the resolved path.
 * Errors: PATH_REJECTED (unsafe string or unsafe resolution), PATH_NOT_ALLOWED (outside),
 * CWD_NOT_FOUND is not used here – a missing file rejects with the fs error (ENOENT).
 */
export async function resolveAllowedPath(path: string, roots: readonly string[]): Promise<string> {
  assertSafePath(path);
  for (const root of roots) assertSafePath(root);
  const resolved = await realpath(path);
  // A junction or symlink may point to a UNC/device path: check the resolved string again.
  assertSafePath(resolved);
  for (const root of roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(root);
    } catch {
      continue;
    }
    if (isWindowsPathInside(resolved, resolvedRoot)) return resolved;
  }
  throw new CommandError(makeError('PATH_NOT_ALLOWED'));
}
