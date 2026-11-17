/**
 * Entries of an installation outside the settings (WP-86 §3, plan §8.1): the start menu shortcut
 * (installer step 6 and every server start of the installation, system/index.ts) and the removal
 * of autostart, protocol handler and start menu for the uninstaller – only the entries of exactly
 * this installation (`<installRoot>\start.mjs`, `installationOnlyMarkers`); a clone's or another
 * program's entry stays. Never throws; runner and environment go through the R6 guard
 * (system/run.ts), so a test run never reaches the real ones.
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

export const APPDATA_MISSING = 'APPDATA is not set';

export interface InstallationEntriesOptions {
  /** Root folder of the installation (`start.mjs`, `parallax.ico`). */
  installRoot: string;
  /** Default `runFile` – never in a test run (system/run.ts). */
  run?: RunFileFn;
  /** APPDATA, SystemRoot (default `process.env` – never in a test run). */
  env?: NodeJS.ProcessEnv;
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
 * A foreign shortcut is never replaced (`reason: 'foreign'`).
 */
export async function ensureStartMenuEntry(opts: StartMenuEntryOptions): Promise<SystemOpResult> {
  const env = systemEnv(opts.env);
  const link = startMenuLinkPath(env);
  if (link === null) return { ok: false, reason: APPDATA_MISSING };
  let command: StartCommand;
  try {
    command = opts.command ?? (await installedLauncherCommand(opts.installRoot, []));
  } catch (error) {
    return { ok: false, reason: `node.exe not resolvable: ${toError(error).message}` };
  }
  return createStartMenuShortcut(link, command, installIconPath(opts.installRoot), {
    run: systemRunner(opts.run),
    env,
    markers: opts.markers ?? entryMarkers(opts.installRoot),
  });
}

export interface InstallationEntriesRemoval {
  autostart: SystemOpResult;
  protocol: SystemOpResult;
  startMenu: SystemOpResult;
}

/**
 * For the uninstaller: removes autostart shortcut, protocol handler and start menu shortcut of
 * this installation, one after another; a missing entry is fine, an entry of anybody else (also a
 * clone's `launcher\main.ts`) stays and counts as done.
 */
export async function removeInstallationEntries(
  opts: InstallationEntriesOptions,
): Promise<InstallationEntriesRemoval> {
  const run = systemRunner(opts.run);
  const env = systemEnv(opts.env);
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
