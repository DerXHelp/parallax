/**
 * `--uninstall` (WP-86, docs/wp/WP-83.md §8.1 "Deinstallieren"): removes autostart, protocol handler
 * and Start menu shortcut of this installation (only own entries), then exactly the names the
 * installer writes into the root (`ROOT_ENTRIES`) and the root itself when it is empty – a file the
 * user put there stays. The data directory stays; the caller names its path.
 *
 * Refused while a server of this installation runs (its version folder is in use). The caller
 * leaves the root as working directory first (the uninstaller itself runs from a version folder).
 */
import { access, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { toError } from '../lib/async';
import { fsErrorCode } from '../lib/paths';
import {
  CURRENT_FILE,
  InstallError,
  ROOT_ENTRIES,
  START_SCRIPT,
  VERSIONS_DIR,
  assertNotRealUserFolder,
} from './layout';
import { listInstalledVersions, versionOfBuild } from './versions';

export interface UninstallDeps {
  /** Removes autostart, protocol handler and Start menu shortcut of `root`; resolves with problems. */
  removeEntries: (root: string) => Promise<string[]>;
  /** Build id of the server running on the data directory, or null. */
  runningBuildId: () => Promise<string | null>;
}

export interface UninstallResult {
  /** Entries or folders that could not be removed. */
  problems: string[];
  /** Names left in the root (not written by the installer); empty = the root is gone. */
  leftovers: string[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function uninstall(root: string, deps: UninstallDeps): Promise<UninstallResult> {
  assertNotRealUserFolder(root);
  const markers = [CURRENT_FILE, START_SCRIPT, VERSIONS_DIR].map((name) => path.join(root, name));
  const found = await Promise.all(markers.map(exists));
  if (!found.some(Boolean)) {
    throw new InstallError(
      `${root} is no Parallax installation (no ${CURRENT_FILE}, ${START_SCRIPT} or ${VERSIONS_DIR})`,
    );
  }
  const running = versionOfBuild(await listInstalledVersions(root), await deps.runningBuildId());
  if (running !== null) {
    throw new InstallError(
      `Parallax ${running} is running from ${root}. Stop it first ("Stop server" in the menu), then ` +
        'uninstall again.',
    );
  }
  const problems = await deps.removeEntries(root);
  for (const name of ROOT_ENTRIES) {
    try {
      await rm(path.join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      problems.push(`${name}: ${toError(error).message}`);
    }
  }
  let leftovers: string[] = [];
  try {
    await rmdir(root);
  } catch (error) {
    if (fsErrorCode(error) !== 'ENOENT') {
      try {
        leftovers = (await readdir(root)).sort();
      } catch {
        leftovers = [];
      }
      if (leftovers.length === 0) problems.push(`${root}: ${toError(error).message}`);
    }
  }
  return { problems, leftovers };
}
