/**
 * The UI a production server serves is a SNAPSHOT of `dist/web`, taken when the server starts
 * (V2-03, ADR-066): `PARALLAX_HOME/ui/<buildId>/`. A later `pnpm build`, `pnpm e2e` or a launcher
 * of another data directory may rebuild `dist/` of the same checkout at any time – the running
 * server keeps serving the UI of its own build (no "Parallax was updated" dead end for windows of
 * an older server, no locked files that make `vite build` fail), and only a restart picks up the new
 * build. `dist/server.js` itself is loaded into memory at the start; nothing else of `dist/` is read
 * later (the history worker is evaluated from a string).
 *
 * The web build carries its id in `dist/web/build.json` (written by vite.config.ts, the same id as
 * the server bundle). The snapshot is taken only when that id equals the server's own `BUILD_ID`:
 * otherwise (half-finished or foreign build, no marker) `dist/web` is served directly with a warning –
 * the behaviour before the snapshot. One snapshot per build is kept and reused by later starts; the
 * home lock (one server per home) makes the copy race-free, older snapshots are removed.
 */
import { cp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { LIMITS } from '@shared/common';
import { withFsRetry } from '../lib/fs';

/** Below PARALLAX_HOME: one folder per build id. */
export const WEB_SNAPSHOT_DIR = 'ui';
/** `dist/web/build.json` = `{"buildId": "<id>"}` (vite.config.ts `parallax:build-info`). */
export const WEB_BUILD_INFO_FILE = 'build.json';
/** Build id of unbundled runs (tsx, Vitest): no stable content → never snapshotted. */
const DEV_BUILD_ID = 'dev';

const webBuildInfoSchema = z.object({ buildId: z.string().min(1).max(LIMITS.buildIdChars) });

/** The build id of a `build.json` text, or null if it is not one. */
export function parseWebBuildId(text: string): string | null {
  try {
    const parsed = webBuildInfoSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.buildId : null;
  } catch {
    return null;
  }
}

/** Build id of a built web UI (`<root>/build.json`), or null if missing/unreadable. */
export async function readWebBuildId(root: string): Promise<string | null> {
  try {
    return parseWebBuildId(await readFile(path.join(root, WEB_BUILD_INFO_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** Folder name of a build id (ids are `[0-9A-Za-z.+_-]`; anything else is replaced). */
export function snapshotDirName(buildId: string): string {
  return buildId.replace(/[^0-9A-Za-z.+_-]/g, '_').replace(/\.+$/, '_');
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export interface PrepareWebRootOptions {
  /** `dist/web` next to the bundle. */
  source: string;
  home: string;
  /** The server's own `BUILD_ID`. */
  buildId: string;
  log: Logger;
}

/**
 * The folder to serve: the snapshot of `source` for `buildId` (taken now if missing), or `source`
 * itself when no snapshot can be used (dev id, web of another build, copy failed). Never throws.
 */
export async function prepareWebRoot(options: PrepareWebRootOptions): Promise<string> {
  const { source, home, buildId, log } = options;
  if (buildId === DEV_BUILD_ID) return source;
  const webBuildId = await readWebBuildId(source);
  if (webBuildId !== buildId) {
    log.warn(
      { source, webBuildId, buildId },
      'the web UI in dist/web belongs to another build - served directly (run "pnpm build")',
    );
    return source;
  }
  const base = path.join(home, WEB_SNAPSHOT_DIR);
  const name = snapshotDirName(buildId);
  const target = path.join(base, name);
  try {
    if (!(await isDirectory(target)) || (await readWebBuildId(target)) !== buildId) {
      // Copy next to the target and rename: a crash never leaves a half snapshot under the id.
      const temp = path.join(base, `.tmp-${String(process.pid)}-${String(Date.now())}`);
      await rm(target, { recursive: true, force: true, maxRetries: 5 });
      await cp(source, temp, { recursive: true, errorOnExist: true, force: false });
      await withFsRetry(() => rename(temp, target));
      log.info({ target, buildId }, 'web UI snapshot taken');
    }
  } catch (error) {
    log.warn({ err: error, source, target }, 'web UI snapshot failed - serving dist/web directly');
    return source;
  }
  // Older builds' snapshots (and temp folders of an aborted copy) are no longer used: only one
  // server runs per home (home lock), and it serves `target`.
  try {
    for (const entry of await readdir(base)) {
      if (entry !== name) await rm(path.join(base, entry), { recursive: true, force: true, maxRetries: 3 });
    }
  } catch (error) {
    log.debug({ err: error, base }, 'old web UI snapshots could not be removed');
  }
  return target;
}
