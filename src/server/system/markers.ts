/**
 * Who owns an entry (WP-86 §3, plan §8.1 "Marker"): the autostart shortcut, the start menu
 * shortcut and the protocol handler are judged by their command line (shortcut arguments,
 * `shell\open\command`; Linux: the `Exec` line of the `.desktop` file), case-insensitive.
 *
 * - own: contains `launcher\main.ts` (a clone or the development repo) or – only for a server of
 *   an installation (`installRoot`) – `<installRoot>\start.mjs`. Own entries are replaced and
 *   removed; with `installRoot` the old `launcher\main.ts` entries are bent over to the installation.
 * - deferred: a clone (no `installRoot`) leaves the entries of an installation (`\start.mjs`) alone,
 *   when creating and when removing – no failure, no warning (plan §8.5: an updated clone must not
 *   bend anything back).
 * - foreign: anything else (the user's or another program's); never replaced, never removed.
 *
 * Linux (WP-106): the same rules with `/` (`launcher/main.ts`, `/start.mjs`); paths are joined the
 * way the root is written (`C:\…` → Windows, `/…` → POSIX), so Windows stays exactly as before.
 */
import path from 'node:path';
import { pathFlavorOfShape, type PathFlavor } from '@shared/paths';

/** Marks a start command of a clone/the repo: the launcher's `main.ts` (R4-11, CR2-03). */
export const LAUNCHER_MARKER = 'launcher\\main.ts';
/** The same on Linux (WP-106). */
export const POSIX_LAUNCHER_MARKER = 'launcher/main.ts';
/** The stable start script in the root folder of an installation (plan §8.1). */
export const INSTALL_START_SCRIPT = 'start.mjs';
/** The icon of the start menu shortcut in the root folder of an installation. */
export const INSTALL_ICON = 'parallax.ico';
/** WP-106: the icon of the `.desktop` program entry in the root folder of a Linux installation. */
export const POSIX_INSTALL_ICON = 'parallax.svg';
/** Marks the start command of any installation (`<root>\start.mjs`). */
export const INSTALL_MARKER = `\\${INSTALL_START_SCRIPT}`;
/** The same on Linux (`<root>/start.mjs`). */
export const POSIX_INSTALL_MARKER = `/${INSTALL_START_SCRIPT}`;

/** Markers (substrings, compared case-insensitively) for the own and the deferred entries. */
export interface EntryMarkers {
  own: readonly string[];
  defer: readonly string[];
}

/** Without explicit markers: only `launcher\main.ts` is own, nothing is deferred (before WP-86). */
export const LAUNCHER_ONLY_MARKERS: EntryMarkers = { own: [LAUNCHER_MARKER], defer: [] };

/** `path.win32` for a Windows-shaped root, `path.posix` for `/…`. */
function joinerOf(root: string): typeof path.posix {
  return pathFlavorOfShape(root) === 'posix' ? path.posix : path.win32;
}

/** `<installRoot>\start.mjs` (`<installRoot>/start.mjs` on Linux) – the script the entries start. */
export function installStartScript(installRoot: string): string {
  return joinerOf(installRoot).join(installRoot, INSTALL_START_SCRIPT);
}

/** `<installRoot>\parallax.ico`; Linux `<installRoot>/parallax.svg` (WP-106). */
export function installIconPath(installRoot: string): string {
  const posix = pathFlavorOfShape(installRoot) === 'posix';
  return joinerOf(installRoot).join(installRoot, posix ? POSIX_INSTALL_ICON : INSTALL_ICON);
}

/**
 * The markers of a server: a clone (`installRoot` null) owns `launcher\main.ts` and defers to any
 * installation; an installation owns `launcher\main.ts` (bent over) and its own `start.mjs` – the
 * entry of another installation is foreign. `flavor` (WP-106): which separator the commands of
 * this host use (default Windows).
 */
export function entryMarkers(installRoot: string | null, flavor: PathFlavor = 'win32'): EntryMarkers {
  const launcher = flavor === 'posix' ? POSIX_LAUNCHER_MARKER : LAUNCHER_MARKER;
  if (installRoot === null) {
    return { own: [launcher], defer: [flavor === 'posix' ? POSIX_INSTALL_MARKER : INSTALL_MARKER] };
  }
  return { own: [launcher, installStartScript(installRoot)], defer: [] };
}

/** The uninstaller (WP-86 §3): only the entries of exactly this installation, nothing else. */
export function installationOnlyMarkers(installRoot: string): EntryMarkers {
  return { own: [installStartScript(installRoot)], defer: [] };
}

export type EntryOwner = 'own' | 'deferred' | 'foreign';

/**
 * reg.exe prints in the OEM code page (lib/registry.ts), so a non-ASCII character of the
 * installation path (e.g. a user name with an umlaut) arrives as U+FFFD or `?`. Both sides fold
 * every run of non-ASCII characters and `?` (never part of a Windows path) into one placeholder;
 * the rest is compared exactly. A DBCS code page can still garble beyond that (fails closed:
 * foreign).
 */
function fold(text: string): string {
  // Printable ASCII except `?` (0x3f) stays; everything else folds, runs into one placeholder.
  return text.toLowerCase().replace(/[^\x20-\x3e\x40-\x7e]+/gu, '\u0000');
}

/** Who owns a command line (see the file comment); own wins over deferred. */
export function entryOwner(command: string, markers: EntryMarkers): EntryOwner {
  const text = fold(command);
  const contains = (list: readonly string[]): boolean =>
    list.some((marker) => marker !== '' && text.includes(fold(marker)));
  if (contains(markers.own)) return 'own';
  if (contains(markers.defer)) return 'deferred';
  return 'foreign';
}
