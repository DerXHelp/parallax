/**
 * Files only the current user may read (POSIX, docs/wp/WP-76.md §B.14 and §B.13 "Launcher-Endpunkt"):
 * key files, `peer.json`/`hosts.json` (kAuth) and the server lock file (launcher token) are written
 * 0600 in folders created 0700 – the permission bits travel with `open`/`mkdir` (the umask can only
 * narrow them), so no moment exists in which a wider file is visible. Windows keeps the default ACLs
 * of the user profile (unchanged behaviour).
 *
 * `checkPrivateFile` is the check before reading a clear-text key (scheme `file`): the file must be a
 * regular file of this user without any group/other bit, its folder must belong to this user and
 * give group/others nothing either.
 */
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { nodeFsOps, type FsOps } from '../lib/fs';
import { fsErrorCode } from '../lib/paths';

/** Mode of a private file (owner read/write). */
export const PRIVATE_FILE_MODE = 0o600;
/** Mode of a private folder (owner only). */
export const PRIVATE_DIR_MODE = 0o700;
/** Group and other bits – none may be set on a private file or folder. */
const GROUP_OTHER_BITS = 0o077;

/** `FsOps` whose new files are 0600 and whose new folders are 0700 (POSIX). */
export const privateFsOps: FsOps = {
  ...nodeFsOps,
  writeFile: async (file, data) => {
    const handle = await open(file, 'w', PRIVATE_FILE_MODE);
    try {
      // An existing temp file keeps its mode: narrow it explicitly.
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  },
};

/** The file system ops for security-relevant files on `platform` (POSIX: private modes). */
export function secureFsOps(platform: NodeJS.Platform = process.platform): FsOps {
  return platform === 'win32' ? nodeFsOps : privateFsOps;
}

/** Narrows an existing folder to 0700 (POSIX; a missing folder is fine). */
export async function narrowPrivateDir(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') return;
  try {
    await chmod(dir, PRIVATE_DIR_MODE);
  } catch (error) {
    if (fsErrorCode(error) !== 'ENOENT') throw error;
  }
}

/** Why a file failed `checkPrivateFile` (null = fine or missing). */
export type PrivateFileIssue = 'not_file' | 'owner' | 'mode' | 'dir_owner' | 'dir_mode';

export interface PrivateFileCheckDeps {
  /** Default `process.getuid()`. */
  uid?: number;
  lstat?: (file: string) => Promise<{ uid: number; mode: number; isFile(): boolean; isDirectory(): boolean }>;
}

/**
 * POSIX check before a clear-text secret is read: the file (if present) is a regular file of this
 * user with mode ⊆ 0600, and its folder belongs to this user with mode ⊆ 0700. Null = fine (also a
 * missing file – the caller treats it as missing). Throws for other read errors.
 */
export async function checkPrivateFile(
  file: string,
  deps: PrivateFileCheckDeps = {},
): Promise<PrivateFileIssue | null> {
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  const stat = deps.lstat ?? lstat;
  let info: Awaited<ReturnType<NonNullable<PrivateFileCheckDeps['lstat']>>>;
  try {
    info = await stat(file);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) return 'not_file';
  if (info.uid !== uid) return 'owner';
  if ((info.mode & GROUP_OTHER_BITS) !== 0) return 'mode';
  const dir = await stat(path.dirname(file));
  if (!dir.isDirectory() || dir.uid !== uid) return 'dir_owner';
  if ((dir.mode & GROUP_OTHER_BITS) !== 0) return 'dir_mode';
  return null;
}
