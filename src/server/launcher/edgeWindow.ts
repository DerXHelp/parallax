/**
 * The Parallax window: Microsoft Edge in app mode with its own profile (Plan "Grundarchitektur",
 * A.8, C.9). Edge is found by `findEdge` (lib/edge.ts: App Paths HKCU/HKLM, Program Files – it is
 * not on the PATH) and started with an argument array, never through a shell or `cmd /c start`.
 * The own `--user-data-dir` keeps token URLs out of the user's browser history and gives stable
 * notification permissions; when that profile is already open, Edge hands the new window to the
 * running browser process and the started `msedge.exe` exits at once.
 *
 * The profile never signs in and never syncs (V2-01, ADR-060): without extra switches a fresh
 * profile is signed in implicitly with the Microsoft account of the Windows user, sync is set up
 * and a modal "We are syncing …" dialog covers the app – URLs with `#code=` would reach the
 * account. Measured with Edge 155 (docs/wp/V2.md "Umsetzung Server"): `msImplicitSignin` disabled
 * keeps the profile signed out, `--disable-sync` keeps sync off even for a signed-in profile;
 * pre-written prefs (`signin.allowed`, `profiles.edge_implicit_sign_in_enabled`) and
 * `--allow-browser-signin=false` alone do NOT stop the implicit sign-in. Only command-line switches –
 * no policies, no registry, no admin rights. A company policy can override them (ADR-060).
 */
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { findEdge } from '../lib/edge';
import { nodeFsOps, writeFileAtomic, type FsOps } from '../lib/fs';
import { fsErrorCode } from '../lib/paths';
import { spawnHidden, type SpawnHiddenOptions } from '../lib/process';
import { regQuery } from '../lib/registry';
import { nodeFsProbe } from '../lib/windows';

/** `<PARALLAX_HOME>\edge`. */
export function edgeProfileDir(home: string): string {
  return path.join(home, 'edge');
}

/**
 * Edge features disabled for the app profile (V2-01): implicit sign-in with the Windows account
 * (the one that matters, verified), first sync on first run, the sync confirmation dialog, forced
 * sign-in and the web-to-browser sign-in prompts. Unknown names are ignored by Edge.
 */
export const EDGE_DISABLED_FEATURES: readonly string[] = [
  'msImplicitSignin',
  'msEdgeFirstSyncOnFirstRun',
  'msWebUISyncConfirmationDialog',
  'msForceBrowserSignIn',
  'msSeamlessWebToBrowserSignIn',
  'msEnableWebToBrowserSignIn',
  'msEnableAADWebToBrowserSignIn',
  'msQuickAuthToBrowserSignIn',
];

/** Arguments for one app window on `url` (`http://127.0.0.1:<port>/#code=<code>`). */
export function edgeAppArgs(options: { home: string; url: string }): string[] {
  return [
    `--user-data-dir=${edgeProfileDir(options.home)}`,
    '--no-first-run',
    '--no-default-browser-check',
    // V2-01: never sync, never sign in implicitly (Chromium switch + Edge features).
    '--disable-sync',
    '--allow-browser-signin=false',
    `--disable-features=${EDGE_DISABLED_FEATURES.join(',')}`,
    `--app=${options.url}`,
  ];
}

const localStateSchema = z.looseObject({
  profile: z
    .looseObject({
      info_cache: z.record(z.string(), z.looseObject({ user_name: z.string().optional() })).optional(),
    })
    .optional(),
});

/**
 * True if a profile in `<home>\edge` is signed in to an account (`Local State`: a non-empty
 * `user_name` – e.g. signed in by a Parallax version before V2-01). Read-only; false if unreadable.
 */
export async function edgeProfileSignedIn(home: string): Promise<boolean> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(edgeProfileDir(home), 'Local State'), 'utf8'));
  } catch {
    return false;
  }
  const parsed = localStateSchema.safeParse(raw);
  if (!parsed.success) return false;
  return Object.values(parsed.data.profile?.info_cache ?? {}).some(
    (info) => (info.user_name ?? '').trim() !== '',
  );
}

/** `<profile>\Default\Preferences` of the app profile. */
export function edgePreferencesFile(home: string): string {
  return path.join(edgeProfileDir(home), 'Default', 'Preferences');
}

/** Chromium time (µs since 1601-01-01) as Edge writes it into `last_modified`. */
export function chromiumTime(date: Date): string {
  return String((BigInt(date.getTime()) + 11_644_473_600_000n) * 1000n);
}

const objectSchema = z.record(z.string(), z.unknown());

export type NotificationGrant =
  { kind: 'granted' } | { kind: 'already' } | { kind: 'skipped'; reason: string };

/**
 * WP22-03: allows Web Notifications for the server origin in the OWN Edge profile before the app
 * window opens – `profile.content_settings.exceptions.notifications["<origin>,*"] = {setting: 1}`
 * in `<home>\edge\Default\Preferences` (merged, written atomically; a new profile gets a minimal
 * file). Reason: Edge shows `Notification.requestPermission()` only as a chip in the address bar,
 * which an app window does not have – the request counts as "ignored". Measured with Edge 155: the
 * pre-written exception is accepted (fresh and existing profile) and a Web Notification is shown
 * (Edge's own popup, also with the window minimized). Only this profile, no policy, no registry.
 * Edge keeps its in-memory prefs while it runs (a running profile writes them back on exit; the
 * exception of the usual port is already there then). Unreadable prefs are left alone. Never throws.
 */
export async function grantEdgeNotifications(
  home: string,
  origin: string,
  options: { now?: () => Date; fs?: FsOps } = {},
): Promise<NotificationGrant> {
  const file = edgePreferencesFile(home);
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

/** Absolute msedge.exe or null (real registry and file system). */
export function locateEdge(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | null> {
  return findEdge({ regQuery: regQuery(), fs: nodeFsProbe, env });
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
 * Starts Edge detached (it must outlive the launcher) and resolves with its PID once the process
 * exists; rejects if it cannot be started (ENOENT, EACCES, policy …).
 */
export async function openEdgeWindow(
  edgePath: string,
  args: readonly string[],
  spawn: SpawnFn = defaultSpawn,
): Promise<{ pid: number | null }> {
  const child = spawn(edgePath, args, { detached: true, stdio: 'ignore' });
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
