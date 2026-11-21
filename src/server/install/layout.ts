/**
 * Folder layout of an installation (WP-86, docs/wp/WP-83.md §8.1, ADR-219):
 *
 *   <root>\parallax.cmd     stable: node start.mjs %*
 *   <root>\start.mjs        stable: reads current.json, loads versions\<v>\dist\launcher.js
 *   <root>\parallax.ico     icon of the Start menu shortcut
 *   <root>\current.json     { schemaVersion, version, previous }
 *   <root>\versions\<v>\    an unpacked, checked package plus the Agent SDK (its `root\` holds the
 *                           root files of that version, WP-87)
 *   <root>\cache\           checked SDK tarballs (install/sdk.ts)
 *   <root>\downloads\       partial downloads
 *
 * The default root is `%LOCALAPPDATA%\Programs\Parallax` (programs per user), apart from the data
 * directory `%LOCALAPPDATA%\Parallax`. Launcher, server and Chrome run with the root as working
 * directory, never with a version folder (a long-lived Chrome would lock it against deletion).
 *
 * Linux (WP-108, WP-100 E7): the same layout in `~/.local/lib/parallax`, with the POSIX start
 * script `parallax` instead of `parallax.cmd` and `parallax.svg` instead of the `.ico` (for the
 * application menu entry of the system integration). The command `~/.local/bin/parallax`
 * (install/command.ts) only runs `<root>/parallax`; the data directory is `$XDG_DATA_HOME/parallax`
 * (lib/dataDir.ts).
 *
 * A test run never touches the real root or the real Start menu (`assertNotRealUserFolder`, like R6
 * of the system integration): tests pass their folders explicitly.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { pathFlavorOf, pathRules, windowsPathIssue, type PathRules } from '@shared/paths';
import { PRODUCT_ID, PRODUCT_NAME } from '@shared/product';
import { isTestRun } from '../config';
import { toError } from '../lib/async';
import { writeFileAtomic } from '../lib/fs';
import { fsErrorCode } from '../lib/paths';
import { getEnvVar } from '../lib/windows';
import { releaseVersionSchema } from '../launcher/release';

export const START_SCRIPT = 'start.mjs';
export const START_CMD = 'parallax.cmd';
/** Linux (WP-108): `<root>/parallax`, the POSIX start script – the counterpart of parallax.cmd. */
export const START_SH = 'parallax';
export const ICON_FILE = 'parallax.ico';
/** Linux (WP-108): the icon of the application menu entry (`.desktop`) – SVG instead of `.ico`. */
export const ICON_SVG = 'parallax.svg';
export const CURRENT_FILE = 'current.json';
export const VERSIONS_DIR = 'versions';
export const CACHE_DIR = 'cache';
export const DOWNLOADS_DIR = 'downloads';
/** `versions\.staging-<v>-<stamp>`: a package being copied and checked. */
export const STAGING_PREFIX = '.staging-';
/** `versions\.trash-<stamp>-<v>`: a version being deleted (rename first, then delete). */
export const TRASH_PREFIX = '.trash-';
/**
 * `root\` inside a package (WP-87): `start.mjs` and `parallax.cmd` of that version, signed with it.
 * Switching to a version writes the root files from `versions\<v>\root\` (else the own templates).
 */
export const PACKAGE_ROOT_DIR = 'root';
/** Every name the installer writes into the root on `platform` (the uninstaller deletes exactly these). */
export function rootEntries(platform: NodeJS.Platform = process.platform): readonly string[] {
  return [
    START_SCRIPT,
    startCommandFile(platform),
    iconFile(platform),
    CURRENT_FILE,
    VERSIONS_DIR,
    CACHE_DIR,
    DOWNLOADS_DIR,
  ];
}
/** The start script in the root on `platform`: `parallax.cmd` (Windows) or `parallax` (POSIX sh). */
export function startCommandFile(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? START_CMD : START_SH;
}
/** The icon the installer copies into the root on `platform`. */
export function iconFile(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? ICON_FILE : ICON_SVG;
}
/** The installer file at the package root (Explorer double click) – `node dist\install.js` is the same. */
export const INSTALL_CMD = 'install.cmd';
/** Linux (WP-108): `sh install.sh` at the package root – checks Node, then runs `dist/install.js`. */
export const INSTALL_SH = 'install.sh';
/** Linux (WP-108): name of the command the installer puts into the bin folder (`~/.local/bin`). */
export const COMMAND_NAME = PRODUCT_ID;
/** The installer bundle inside a package. */
export const INSTALLER_BUNDLE = path.join('dist', 'install.js');
/** The launcher bundle inside a package. */
export const LAUNCHER_BUNDLE = path.join('dist', 'launcher.js');

/** The path rules of `platform` (Windows or POSIX, `@shared/paths`). */
export function installPathRules(platform: NodeJS.Platform = process.platform): PathRules {
  return pathRules(pathFlavorOf(platform));
}

/** POSIX: `HOME` (else the account's home folder), only when the POSIX rules accept it. */
function posixHome(env: NodeJS.ProcessEnv): string | null {
  const home = env.HOME !== undefined && env.HOME !== '' ? env.HOME : os.homedir();
  return installPathRules('linux').issue(home) === null ? home : null;
}

/**
 * The default root: Windows `%LOCALAPPDATA%\Programs\Parallax`, Linux (E7) `~/.local/lib/parallax`.
 * Null without a safe LOCALAPPDATA resp. home folder.
 */
export function defaultInstallRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32') {
    const home = posixHome(env);
    return home === null ? null : path.posix.join(home, '.local', 'lib', PRODUCT_ID);
  }
  const local = getEnvVar(env, 'LOCALAPPDATA', platform);
  if (local === undefined || windowsPathIssue(local) !== null) return null;
  return path.win32.join(local, 'Programs', PRODUCT_NAME);
}

/**
 * Linux (E7): the folder of the `parallax` command, `~/.local/bin` (XDG user executables, on the
 * PATH of Ubuntu's default profile). Null on Windows (the Start menu is the entry there) and without
 * a safe home folder.
 */
export function defaultBinDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === 'win32') return null;
  const home = posixHome(env);
  return home === null ? null : path.posix.join(home, '.local', 'bin');
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

/**
 * Why an installation step failed (WP-87 maps it to an update error code, docs/wp/WP-87.md §2.1):
 * `signature` (release.json signature missing or invalid), `node` (Node.js older than `minNode`),
 * `files` (package or version folder does not match release.json), `sdk` (Agent SDK step or the
 * installed SDK), `in_use` (a version folder is locked), `io` (anything else: disk, current.json …).
 */
export const INSTALL_ERROR_REASONS = ['signature', 'node', 'files', 'sdk', 'in_use', 'io'] as const;
export type InstallErrorReason = (typeof INSTALL_ERROR_REASONS)[number];

export interface InstallErrorOptions extends ErrorOptions {
  /** Default `io`. */
  reason?: InstallErrorReason;
}

export class InstallError extends Error {
  readonly reason: InstallErrorReason;
  constructor(message: string, options: InstallErrorOptions = {}) {
    const { reason = 'io', ...rest } = options;
    super(message, rest);
    this.name = 'InstallError';
    this.reason = reason;
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
 * The real per-user folders a test must never write to: the default root and the Start menu (Linux:
 * the root and the bin folder), from the environment AND from the profile folder (a test may have
 * replaced the variables).
 */
function realUserFolders(platform: NodeJS.Platform): string[] {
  const home = os.homedir();
  if (platform !== 'win32') {
    const folders = [
      path.posix.join(home, '.local', 'lib', PRODUCT_ID),
      path.posix.join(home, '.local', 'bin'),
    ];
    const root = defaultInstallRoot(process.env, platform);
    const bin = defaultBinDir(process.env, platform);
    if (root !== null) folders.push(root);
    if (bin !== null) folders.push(bin);
    return folders;
  }
  const folders = [
    path.win32.join(home, 'AppData', 'Local', 'Programs', PRODUCT_NAME),
    path.win32.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu'),
  ];
  const root = defaultInstallRoot(process.env, platform);
  if (root !== null) folders.push(root);
  const appData = getEnvVar(process.env, 'APPDATA', platform);
  if (appData !== undefined && windowsPathIssue(appData) === null) {
    folders.push(path.win32.join(appData, 'Microsoft', 'Windows', 'Start Menu'));
  }
  return folders;
}

/**
 * In a test run (Vitest, `NODE_ENV=test`): throws for the real installation folder or the real
 * Start menu (Linux: the real root and `~/.local/bin`) and anything inside. Outside tests it does
 * nothing.
 */
export function assertNotRealUserFolder(target: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isTestRun(env)) return;
  const rules = installPathRules(process.platform);
  for (const folder of realUserFolders(process.platform)) {
    if (rules.isInside(target, folder)) {
      throw new InstallError(`tests must not use the real folder ${folder} (got ${target})`);
    }
  }
}
