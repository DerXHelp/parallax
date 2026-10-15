/**
 * The Parallax window: Microsoft Edge in app mode with its own profile (Plan "Grundarchitektur",
 * A.8, C.9). Edge is found by `findEdge` (lib/edge.ts: App Paths HKCU/HKLM, Program Files – it is
 * not on the PATH) and started with an argument array, never through a shell or `cmd /c start`.
 * The own `--user-data-dir` keeps token URLs out of the user's browser history and gives stable
 * notification permissions; when that profile is already open, Edge hands the new window to the
 * running browser process and the started `msedge.exe` exits at once.
 */
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { findEdge } from '../lib/edge';
import { spawnHidden, type SpawnHiddenOptions } from '../lib/process';
import { regQuery } from '../lib/registry';
import { nodeFsProbe } from '../lib/windows';

/** `<PARALLAX_HOME>\edge`. */
export function edgeProfileDir(home: string): string {
  return path.join(home, 'edge');
}

/** Arguments for one app window on `url` (`http://127.0.0.1:<port>/#code=<code>`). */
export function edgeAppArgs(options: { home: string; url: string }): string[] {
  return [
    `--user-data-dir=${edgeProfileDir(options.home)}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--app=${options.url}`,
  ];
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
