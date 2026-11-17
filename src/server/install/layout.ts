/**
 * Folder layout of an installation (WP-86, docs/wp/WP-83.md §8.1, ADR-219):
 *
 *   <root>\parallax.cmd     stable: node start.mjs %*
 *   <root>\start.mjs        stable: reads current.json, loads versions\<v>\dist\launcher.js
 *   <root>\parallax.ico     icon of the Start menu shortcut
 *   <root>\current.json     { schemaVersion, version, previous }
 *   <root>\versions\<v>\    an unpacked, checked package plus the Agent SDK
 *   <root>\cache\           checked SDK tarballs (install/sdk.ts)
 *   <root>\downloads\       partial downloads
 *
 * The default root is `%LOCALAPPDATA%\Programs\Parallax` (programs per user), apart from the data
 * directory `%LOCALAPPDATA%\Parallax`. Launcher, server and Chrome run with the root as working
 * directory, never with a version folder (a long-lived Chrome would lock it against deletion).
 *
 * A test run never touches the real root or the real Start menu (`assertNotRealUserFolder`, like R6
 * of the system integration): tests pass their folders explicitly.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { isWindowsPathInside, windowsPathIssue } from '@shared/paths';
import { PRODUCT_NAME } from '@shared/product';
import { isTestRun } from '../config';
import { toError } from '../lib/async';
import { writeFileAtomic } from '../lib/fs';
import { fsErrorCode } from '../lib/paths';
import { getEnvVar } from '../lib/windows';
import { releaseVersionSchema } from '../launcher/release';

export const START_SCRIPT = 'start.mjs';
export const START_CMD = 'parallax.cmd';
export const ICON_FILE = 'parallax.ico';
export const CURRENT_FILE = 'current.json';
export const VERSIONS_DIR = 'versions';
export const CACHE_DIR = 'cache';
export const DOWNLOADS_DIR = 'downloads';
/** `versions\.staging-<v>-<stamp>`: a package being copied and checked. */
export const STAGING_PREFIX = '.staging-';
/** `versions\.trash-<stamp>-<v>`: a version being deleted (rename first, then delete). */
export const TRASH_PREFIX = '.trash-';
/** Every name the installer writes into the root (the uninstaller deletes exactly these). */
export const ROOT_ENTRIES: readonly string[] = [
  START_SCRIPT,
  START_CMD,
  ICON_FILE,
  CURRENT_FILE,
  VERSIONS_DIR,
  CACHE_DIR,
  DOWNLOADS_DIR,
];
/** The installer file at the package root (Explorer double click) – `node dist\install.js` is the same. */
export const INSTALL_CMD = 'install.cmd';
/** The installer bundle inside a package. */
export const INSTALLER_BUNDLE = path.join('dist', 'install.js');
/** The launcher bundle inside a package. */
export const LAUNCHER_BUNDLE = path.join('dist', 'launcher.js');

/** `%LOCALAPPDATA%\Programs\Parallax`, or null without a safe LOCALAPPDATA. */
export function defaultInstallRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const local = getEnvVar(env, 'LOCALAPPDATA');
  if (local === undefined || windowsPathIssue(local) !== null) return null;
  return path.win32.join(local, 'Programs', PRODUCT_NAME);
}

export function versionDir(root: string, version: string): string {
  return path.join(root, VERSIONS_DIR, version);
}

export const currentFileSchema = z.object({
  schemaVersion: z.literal(1),
  /** The version start.mjs loads. */
  version: releaseVersionSchema,
  /** The version before (way back, protected by the cleanup), null after the first installation. */
  previous: releaseVersionSchema.nullable(),
});
export type CurrentFile = z.infer<typeof currentFileSchema>;

export class InstallError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InstallError';
  }
}

/** `<root>\current.json`, null without one; a broken file throws `InstallError`. */
export async function readCurrent(root: string): Promise<CurrentFile | null> {
  const file = path.join(root, CURRENT_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return null;
    throw new InstallError(`${file} could not be read: ${toError(error).message}`, { cause: error });
  }
  try {
    return currentFileSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new InstallError(`${file} is damaged`, { cause: error });
  }
}

export async function writeCurrent(root: string, current: CurrentFile): Promise<void> {
  await writeFileAtomic(path.join(root, CURRENT_FILE), `${JSON.stringify(current, null, 2)}\n`);
}

/**
 * The real per-user folders a test must never write to: the default root and the Start menu,
 * from the environment AND from the profile folder (a test may have replaced the variables).
 */
function realUserFolders(): string[] {
  const home = os.homedir();
  const folders = [
    path.win32.join(home, 'AppData', 'Local', 'Programs', PRODUCT_NAME),
    path.win32.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu'),
  ];
  const root = defaultInstallRoot(process.env);
  if (root !== null) folders.push(root);
  const appData = getEnvVar(process.env, 'APPDATA');
  if (appData !== undefined && windowsPathIssue(appData) === null) {
    folders.push(path.win32.join(appData, 'Microsoft', 'Windows', 'Start Menu'));
  }
  return folders;
}

/**
 * In a test run (Vitest, `NODE_ENV=test`): throws for the real installation folder or the real
 * Start menu (and anything inside). Outside tests it does nothing.
 */
export function assertNotRealUserFolder(target: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isTestRun(env)) return;
  for (const folder of realUserFolders()) {
    if (isWindowsPathInside(target, folder)) {
      throw new InstallError(`tests must not use the real folder ${folder} (got ${target})`);
    }
  }
}
