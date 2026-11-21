/**
 * Entries of an installation outside the settings (WP-86 §3, plan §8.1): the start menu shortcut
 * (installer step 6 and every server start of the installation, system/index.ts) and the removal
 * of autostart, protocol handler and start menu for the uninstaller – only the entries of exactly
 * this installation (`<installRoot>\start.mjs`, `installationOnlyMarkers`); a clone's or another
 * program's entry stays. Never throws; runner and environment go through the R6 guard
 * (system/run.ts), so a test run never reaches the real ones.
 *
 * Linux (WP-106): the same two functions over the `.desktop` entries (system/xdg.ts) – the program
 * entry `~/.local/share/applications/parallax.desktop` with `<root>/parallax.svg`, and for the
 * uninstaller the autostart entry, the `parallax:` handler entry and the program entry of exactly
 * this installation (`<root>/start.mjs`).
 */
import { toError } from '../lib/async';
import type { RunFileFn } from '../lib/process';
import { regAddValue, regDeleteKey } from '../lib/registry';
import {
  autostartLinkExists,
  autostartLinkPath,
  createStartMenuShortcut,
  installedLauncherCommand,
  removeAutostartShortcut,
  removeStartMenuShortcut,
  startMenuLinkPath,
  type ShortcutOptions,
  type StartCommand,
} from './autostart';
import { entryMarkers, installIconPath, installationOnlyMarkers, type EntryMarkers } from './markers';
import { regKeyReader, unregisterProtocolHandler } from './protocol';
import { systemEnv, systemRunner, type SystemOpResult } from './run';
import {
  HOME_MISSING,
  autostartEntryPath,
  ensureProgramEntry,
  nodeDesktopFs,
  programEntryPath,
  removeDesktopEntry,
  removeProgramEntry,
  unregisterUrlHandler,
  type DesktopFs,
} from './xdg';

export const APPDATA_MISSING = 'APPDATA is not set';

export interface InstallationEntriesOptions {
  /** Root folder of the installation (`start.mjs`, `parallax.ico`; Linux `parallax.svg`). */
  installRoot: string;
  /** Default `runFile` – never in a test run (system/run.ts). */
  run?: RunFileFn;
  /** APPDATA, SystemRoot; Linux HOME, XDG_* (default `process.env` – never in a test run). */
  env?: NodeJS.ProcessEnv;
  /** WP-106: which entries (default `process.platform`; Linux: `.desktop` files). */
  platform?: NodeJS.Platform;
  /** Linux: file access of the `.desktop` entries (default the real file system; tests: memory). */
  desktopFs?: DesktopFs;
}

export interface StartMenuEntryOptions extends InstallationEntriesOptions {
  /**
   * The start command; default `installedLauncherCommand(installRoot, [])` – never with `--home`:
   * the start menu always starts the default data directory, like the installer's shortcut.
   */
  command?: StartCommand;
  /** Default `entryMarkers(installRoot)`. */
  markers?: EntryMarkers;
}

/**
 * Creates or refreshes `<APPDATA>\…\Start Menu\Programs\Parallax.lnk` on `node.exe
 * <root>\start.mjs` with `<root>\parallax.ico` (a node update repairs itself at the next start).
 * A foreign shortcut is never replaced (`reason: 'foreign'`). Linux: the program entry
 * `parallax.desktop` with `<root>/parallax.svg` (the same rules).
 */
export async function ensureStartMenuEntry(opts: StartMenuEntryOptions): Promise<SystemOpResult> {
  const env = systemEnv(opts.env);
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' && platform !== 'linux') return { ok: false, reason: 'unsupported platform' };
  let command: StartCommand;
  const missing = platform === 'win32' ? startMenuLinkPath(env) === null : programEntryPath(env) === null;
  if (missing) return { ok: false, reason: platform === 'win32' ? APPDATA_MISSING : HOME_MISSING };
  try {
    command = opts.command ?? (await installedLauncherCommand(opts.installRoot, []));
  } catch (error) {
    return { ok: false, reason: `node.exe not resolvable: ${toError(error).message}` };
  }
  const markers = opts.markers ?? entryMarkers(opts.installRoot, platform === 'win32' ? 'win32' : 'posix');
  const run = systemRunner(opts.run);
  if (platform === 'linux') {
    return ensureProgramEntry(command, installIconPath(opts.installRoot), {
      run,
      env,
      markers,
      fs: opts.desktopFs ?? nodeDesktopFs,
    });
  }
  const link = startMenuLinkPath(env);
  if (link === null) return { ok: false, reason: APPDATA_MISSING };
  return createStartMenuShortcut(link, command, installIconPath(opts.installRoot), { run, env, markers });
}

export interface InstallationEntriesRemoval {
  autostart: SystemOpResult;
  protocol: SystemOpResult;
  startMenu: SystemOpResult;
}

/** Linux (WP-106): the three `.desktop` entries of exactly this installation. */
async function removeLinuxEntries(
  opts: InstallationEntriesOptions,
  run: RunFileFn,
  env: NodeJS.ProcessEnv,
): Promise<InstallationEntriesRemoval> {
  const xdg = {
    run,
    env,
    markers: installationOnlyMarkers(opts.installRoot),
    fs: opts.desktopFs ?? nodeDesktopFs,
  };
  const autostartFile = autostartEntryPath(env);
  const autostart: SystemOpResult =
    autostartFile === null
      ? { ok: false, reason: HOME_MISSING }
      : await removeDesktopEntry(autostartFile, xdg);
  const protocol = await unregisterUrlHandler(xdg);
  const startMenu = await removeProgramEntry(xdg);
  return { autostart, protocol, startMenu };
}

/**
 * For the uninstaller: removes autostart shortcut, protocol handler and start menu shortcut of
 * this installation, one after another; a missing entry is fine, an entry of anybody else (also a
 * clone's `launcher\main.ts`) stays and counts as done. Linux: the `.desktop` entries.
 */
export async function removeInstallationEntries(
  opts: InstallationEntriesOptions,
): Promise<InstallationEntriesRemoval> {
  const run = systemRunner(opts.run);
  const env = systemEnv(opts.env);
  const platform = opts.platform ?? process.platform;
  if (platform === 'linux') return removeLinuxEntries(opts, run, env);
  const markers = installationOnlyMarkers(opts.installRoot);
  const shortcut: ShortcutOptions = { run, env, markers };
  const removeLink = async (
    link: string | null,
    remove: (link: string, opts: ShortcutOptions) => Promise<SystemOpResult>,
  ): Promise<SystemOpResult> => {
    if (link === null) return { ok: false, reason: APPDATA_MISSING };
    return (await autostartLinkExists(link)) ? remove(link, shortcut) : { ok: true };
  };
  const autostart = await removeLink(autostartLinkPath(env), removeAutostartShortcut);
  const protocol = await unregisterProtocolHandler({
    read: regKeyReader(run),
    add: regAddValue(run),
    remove: regDeleteKey(run),
    env,
    markers,
  });
  const startMenu = await removeLink(startMenuLinkPath(env), removeStartMenuShortcut);
  return { autostart, protocol, startMenu };
}
