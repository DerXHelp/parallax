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
 */
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { findChrome } from '../lib/chrome';
import { nodeFsOps, writeFileAtomic, type FsOps } from '../lib/fs';
import { fsErrorCode } from '../lib/paths';
import { spawnHidden, type SpawnHiddenOptions } from '../lib/process';
import { regQuery } from '../lib/registry';
import { nodeFsProbe } from '../lib/windows';

/** `<PARALLAX_HOME>\chrome` (the Edge profile `<home>\edge` of earlier versions stays untouched). */
export function chromeProfileDir(home: string): string {
  return path.join(home, 'chrome');
}

/**
 * ADR-120: the app profile only ever loads the Parallax origin on 127.0.0.1, so its windows may
 * play the synthesized notification sounds (ADR-109) without a prior click – a window from the
 * autostart or a toast click would otherwise stay silent until the first interaction.
 */
export const CHROME_AUTOPLAY_POLICY = '--autoplay-policy=no-user-gesture-required';

/** Arguments for one app window on `url` (`http://127.0.0.1:<port>/#code=<code>`). */
export function chromeAppArgs(options: { home: string; url: string }): string[] {
  return [
    `--user-data-dir=${chromeProfileDir(options.home)}`,
    // No first-run UI (welcome tab, sign-in promo), no "Chrome is not your default browser" bar.
    '--no-first-run',
    '--no-default-browser-check',
    // ADR-060/ADR-136: never sync, never sign in (measured, see the file comment).
    '--disable-sync',
    '--allow-browser-signin=false',
    CHROME_AUTOPLAY_POLICY,
    `--app=${options.url}`,
  ];
}

/** `<profile>\Default\Preferences` of the app profile. */
export function chromePreferencesFile(home: string): string {
  return path.join(chromeProfileDir(home), 'Default', 'Preferences');
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
  options: { now?: () => Date; fs?: FsOps } = {},
): Promise<NotificationGrant> {
  const file = chromePreferencesFile(home);
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

/** Absolute chrome.exe or null (real registry and file system). */
export function locateChrome(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | null> {
  return findChrome({ regQuery: regQuery(), fs: nodeFsProbe, env });
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
): Promise<{ pid: number | null }> {
  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
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
