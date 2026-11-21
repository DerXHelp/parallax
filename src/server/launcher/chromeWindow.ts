/**
 * The Parallax window: Google Chrome in app mode with its own profile (Plan "Grundarchitektur",
 * A.8, C.9; ADR-136 replaced Microsoft Edge). Chrome is found by `findChrome` (lib/chrome.ts: App
 * Paths HKCU/HKLM, Program Files, %LOCALAPPDATA% – it is not on the PATH) and started with an
 * argument array, never through a shell or `cmd /c start`. The own `--user-data-dir` keeps token
 * URLs out of the user's browser history and gives stable notification permissions; when that
 * profile is already open, Chrome hands the new window to the running browser process and the
 * started `chrome.exe` exits at once.
 *
 * The profile never signs in and never syncs (ADR-060, ADR-136). Measured with Chrome 156
 * (headless, temp profiles, `chrome://signin-internals`, `chrome://prefs-internals`, profile files;
 * docs/wp/CHROME.md §4): unlike Edge, a fresh Chrome profile is NOT signed in implicitly – also
 * without any switch, also at the second start. `--disable-sync` keeps the sync service off even if
 * an account were added; `--allow-browser-signin=false` sets `signin.allowed=false` (account
 * consistency "None"), so the profile cannot be signed in at all – not even after a Google login
 * on a page opened from a link. Only command-line switches – no policies, no registry, no admin
 * rights. A company policy can override them (`pnpm preflight`, "chrome policies").
 *
 * Linux (WP-106, WP-100 §5.3): Chrome or Chromium from `findChromeLinux` (lib/chrome.ts), the same
 * switches plus `--class=parallax` – the WM class the `.desktop` entries name in `StartupWMClass`
 * (system/xdg.ts), so the window belongs to the Parallax entry in the dock. Chromium as a Snap must
 * not write hidden folders in `$HOME` (`~/.local/share/parallax` is one): its profile lives in the
 * Snap's own folder `~/snap/chromium/common/parallax-<hash of the data directory>` instead – one
 * profile per data directory, like `<home>/chrome`. Callers pass the located program (`chrome`) to
 * every profile function, so the window and the notification grant use the same folder.
 */
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { POSIX_PATHS, pathFlavorOfShape, pathRules } from '@shared/paths';
import { findChrome, findChromeLinux, isSnapChrome } from '../lib/chrome';
import { nodeFsOps, writeFileAtomic, type FsOps } from '../lib/fs';
import { fsErrorCode, pathModuleOf } from '../lib/paths';
import { spawnHidden, type SpawnHiddenOptions } from '../lib/process';
import { regQuery } from '../lib/registry';
import { nodeFsProbe } from '../lib/windows';

/** WM class of the Parallax window on Linux (`--class`, `StartupWMClass` of the `.desktop` entries). */
export const CHROME_WM_CLASS = 'parallax';

/** Where Chrome runs: the located program (Snap Chromium needs another profile folder) and `HOME`. */
export interface ChromeProfileOptions {
  /** The located Chrome (`locateChrome`); absent/null = the usual profile `<home>/chrome`. */
  chrome?: string | null;
  /** `HOME` for the Snap's folder (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** `$HOME/snap/chromium/common/parallax-<16 hex>`, or null without a safe absolute `HOME`. */
function snapProfileDir(home: string, env: Readonly<Record<string, string | undefined>>): string | null {
  const userHome = env.HOME;
  if (userHome === undefined || POSIX_PATHS.issue(userHome) !== null) return null;
  const hash = createHash('sha256').update(POSIX_PATHS.key(home), 'utf8').digest('hex').slice(0, 16);
  return path.posix.join(userHome, 'snap', 'chromium', 'common', `parallax-${hash}`);
}

/** The path module that joins like `file` is written (`C:\…` → win32, `/…` → posix). */
function joinerOf(file: string): typeof path.posix {
  return pathModuleOf(pathRules(pathFlavorOfShape(file)));
}

/**
 * `<PARALLAX_HOME>\chrome` (the Edge profile `<home>\edge` of earlier versions stays untouched),
 * joined the way the data directory is written; Snap Chromium: the Snap's own folder (file comment).
 */
export function chromeProfileDir(home: string, options: ChromeProfileOptions = {}): string {
  const chrome = options.chrome ?? null;
  if (chrome !== null && isSnapChrome(chrome)) {
    const snap = snapProfileDir(home, options.env ?? process.env);
    if (snap !== null) return snap;
  }
  return joinerOf(home).join(home, 'chrome');
}

/**
 * ADR-120: the app profile only ever loads the Parallax origin on 127.0.0.1, so its windows may
 * play the synthesized notification sounds (ADR-109) without a prior click – a window from the
 * autostart or a toast click would otherwise stay silent until the first interaction.
 */
export const CHROME_AUTOPLAY_POLICY = '--autoplay-policy=no-user-gesture-required';

/**
 * Arguments for one app window on `url` (`http://127.0.0.1:<port>/#code=<code>`); Linux adds
 * `--class=parallax` (file comment).
 */
export function chromeAppArgs(
  options: { home: string; url: string; platform?: NodeJS.Platform } & ChromeProfileOptions,
): string[] {
  const platform = options.platform ?? process.platform;
  return [
    `--user-data-dir=${chromeProfileDir(options.home, options)}`,
    // No first-run UI (welcome tab, sign-in promo), no "Chrome is not your default browser" bar.
    '--no-first-run',
    '--no-default-browser-check',
    // ADR-060/ADR-136: never sync, never sign in (measured, see the file comment).
    '--disable-sync',
    '--allow-browser-signin=false',
    CHROME_AUTOPLAY_POLICY,
    ...(platform === 'linux' ? [`--class=${CHROME_WM_CLASS}`] : []),
    `--app=${options.url}`,
  ];
}

/** `<profile>\Default\Preferences` of the app profile. */
export function chromePreferencesFile(home: string, options: ChromeProfileOptions = {}): string {
  const profile = chromeProfileDir(home, options);
  return joinerOf(profile).join(profile, 'Default', 'Preferences');
}

/** Chromium time (µs since 1601-01-01) as Chrome writes it into `last_modified`. */
export function chromiumTime(date: Date): string {
  return String((BigInt(date.getTime()) + 11_644_473_600_000n) * 1000n);
}

const objectSchema = z.record(z.string(), z.unknown());

export type NotificationGrant =
  { kind: 'granted' } | { kind: 'already' } | { kind: 'skipped'; reason: string };

/**
 * WP22-03 (ADR-082): allows Web Notifications for the server origin in the OWN Chrome profile before
 * the app window opens – `profile.content_settings.exceptions.notifications["<origin>,*"] =
 * {setting: 1}` in `<home>\chrome\Default\Preferences` (merged, written atomically; a new profile
 * gets a minimal file). Reason: Chromium shows `Notification.requestPermission()` only as a chip in
 * the address bar, which an app window does not have – the request counts as "ignored". Measured
 * with Chrome 156: the pre-written exception is accepted (fresh and existing profile,
 * `Notification.permission === 'granted'`). Only this profile, no policy, no registry. Chrome keeps
 * its in-memory prefs while it runs (a running profile writes them back on exit; the exception of
 * the usual port is already there then). Unreadable prefs are left alone. Never throws.
 */
export async function grantChromeNotifications(
  home: string,
  origin: string,
  options: { now?: () => Date; fs?: FsOps } & ChromeProfileOptions = {},
): Promise<NotificationGrant> {
  const file = chromePreferencesFile(home, options);
  const fs = options.fs ?? nodeFsOps;
  let prefs: Record<string, unknown> = {};
  try {
    const parsed = objectSchema.safeParse(JSON.parse(await fs.readFile(file)));
    if (!parsed.success) return { kind: 'skipped', reason: 'preferences are no JSON object' };
    prefs = parsed.data;
  } catch (error) {
    if (fsErrorCode(error) !== 'ENOENT') {
      return { kind: 'skipped', reason: `preferences unreadable (${fsErrorCode(error) ?? 'parse error'})` };
    }
  }
  const pattern = `${origin},*`;
  /** The object under `key` (absent = empty); a non-object fails the parse. */
  const child = (parent: Record<string, unknown> | undefined, key: string) =>
    objectSchema.safeParse(parent?.[key] ?? {});
  const profile = child(prefs, 'profile');
  const contentSettings = child(profile.data, 'content_settings');
  const exceptions = child(contentSettings.data, 'exceptions');
  const notifications = child(exceptions.data, 'notifications');
  if (!profile.success || !contentSettings.success || !exceptions.success || !notifications.success) {
    return { kind: 'skipped', reason: 'unexpected preferences layout' };
  }
  const current = objectSchema.safeParse(notifications.data[pattern]);
  if (current.success && current.data.setting === 1) return { kind: 'already' };
  const next = {
    ...prefs,
    profile: {
      ...profile.data,
      content_settings: {
        ...contentSettings.data,
        exceptions: {
          ...exceptions.data,
          notifications: {
            ...notifications.data,
            [pattern]: {
              ...(current.success ? current.data : {}),
              last_modified: chromiumTime((options.now ?? (() => new Date()))()),
              setting: 1,
            },
          },
        },
      },
    },
  };
  try {
    await writeFileAtomic(file, JSON.stringify(next), { fs });
    return { kind: 'granted' };
  } catch (error) {
    return { kind: 'skipped', reason: `preferences not writable (${fsErrorCode(error) ?? 'error'})` };
  }
}

/**
 * Absolute Chrome or null (real registry and file system): Windows `chrome.exe` (`findChrome`),
 * Linux Chrome or Chromium (`findChromeLinux`; `configured` = an absolute program to try first),
 * other platforms none.
 */
export function locateChrome(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  configured: string | null = null,
): Promise<string | null> {
  if (platform === 'win32') return findChrome({ regQuery: regQuery(), fs: nodeFsProbe, env });
  if (platform === 'linux') return findChromeLinux({ fs: nodeFsProbe, env, configured });
  return Promise.resolve(null);
}

/** The part of a ChildProcess the launcher uses (spawnHidden returns a full ChildProcess). */
export interface SpawnedChild {
  readonly pid?: number | undefined;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}

export type SpawnFn = (file: string, args: readonly string[], options: SpawnHiddenOptions) => SpawnedChild;

/** Type check: the real spawner fits the seam. */
const defaultSpawn: SpawnFn = (file, args, options): ChildProcess => spawnHidden(file, args, options);

/**
 * Starts Chrome detached (it must outlive the launcher) and resolves with its PID once the process
 * exists; rejects if it cannot be started (ENOENT, EACCES, policy …).
 */
export async function openChromeWindow(
  chromePath: string,
  args: readonly string[],
  spawn: SpawnFn = defaultSpawn,
  cwd?: string,
): Promise<{ pid: number | null }> {
  // WP-85: a long-lived Chrome must not hold a version folder of an installation (cwd = its root).
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    ...(cwd === undefined ? {} : { cwd }),
  });
  const pid = await new Promise<number | null>((resolve, reject) => {
    child.once('error', (error) => {
      reject(error);
    });
    child.once('spawn', () => {
      resolve(child.pid ?? null);
    });
  });
  child.unref();
  return { pid };
}
