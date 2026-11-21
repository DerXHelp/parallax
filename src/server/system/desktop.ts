/**
 * Programs of a Linux desktop after a user click (WP-106, WP-100 §5.6) – the counterparts of
 * `spawnExplorer` (lib/process.ts) on Windows:
 *
 * - `xdgOpen(target)`: the default program of a file, the default browser of a link, the handler of
 *   a `parallax:` URI – `/usr/bin/xdg-open <target>` (absolute, `systemTool`), detached, no shell,
 *   stdio ignored, the environment of a GUI program (`guiEnvironment`). `spawnGui` refuses openers
 *   on purpose (its block list), so this is the one place that starts `xdg-open`; callers check the
 *   target first (paths absolute and safe, the default-program extension list, http(s) links).
 * - `showInFileManager(path, directory)`: D-Bus `org.freedesktop.FileManager1.ShowItems` (a file,
 *   selected in its folder) or `ShowFolders` (a folder) through `/usr/bin/gdbus` (bounded); if that
 *   fails (no file manager on the bus), `xdg-open` on the folder.
 *
 * Failures → CommandError OPEN_FAILED {reason}. Never through a shell; the URI goes into the GVariant
 * text as `'file:///…'` (percent-encoded, `'` too). A test run never starts the real programs (the
 * R6 guard of system/run.ts): tests inject `spawn` and `run`.
 */
import path from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { makeError } from '@shared/errors';
import { POSIX_PATHS } from '@shared/paths';
import {
  assertSpawnableFile,
  errnoCode,
  guiEnvironment,
  systemTool,
  type GuiChild,
  type GuiSpawnFn,
  type RunFileFn,
} from '../lib/process';
import { CommandError } from '../sync/ports';
import { TEST_RUN_REFUSAL, isTestProcess, systemRunner } from './run';

export const FILE_MANAGER_TIMEOUT_MS = 5_000;
const FILE_MANAGER_DEST = 'org.freedesktop.FileManager1';
const FILE_MANAGER_PATH = '/org/freedesktop/FileManager1';

export interface DesktopOpenOptions {
  /** Base environment (default `process.env`), filtered by `guiEnvironment`. */
  env?: NodeJS.ProcessEnv;
  /** Start of `xdg-open` (default `child_process.spawn` – never in a test run). */
  spawn?: GuiSpawnFn;
  /** Runner of `gdbus` (default `runFile` – never in a test run). */
  run?: RunFileFn;
  /** Absolute program of a tool name (default `systemTool(name, env, 'linux')`). */
  tool?: (name: string) => string;
}

function openFailed(reason: string): CommandError {
  return new CommandError(makeError('OPEN_FAILED', { reason }));
}

const defaultSpawn: GuiSpawnFn = (file, args, options) => {
  if (isTestProcess()) throw new Error(TEST_RUN_REFUSAL);
  return nodeSpawn(file, [...args], options);
};

function toolOf(opts: DesktopOpenOptions): (name: string) => string {
  return opts.tool ?? ((name: string) => systemTool(name, opts.env ?? process.env, 'linux'));
}

/** `file:///…` of an absolute POSIX path; `'` encoded too (the GVariant string quote). */
export function posixFileUri(file: string): string {
  const encoded = file
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/'/g, '%27'))
    .join('/');
  return `file://${encoded}`;
}

/** Starts `xdg-open <target>` detached (see the file comment). Throws OPEN_FAILED. */
export async function xdgOpen(target: string, opts: DesktopOpenOptions = {}): Promise<void> {
  if (target === '' || target.startsWith('-')) throw openFailed('path');
  const file = toolOf(opts)('xdg-open');
  try {
    assertSpawnableFile(file, 'linux');
  } catch {
    throw openFailed('path');
  }
  const options: SpawnOptions = {
    cwd: POSIX_PATHS.issue(target) === null ? path.posix.dirname(target) : '/',
    env: guiEnvironment(opts.env, 'linux'),
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  };
  const spawn = opts.spawn ?? defaultSpawn;
  await new Promise<void>((resolve, reject) => {
    let child: GuiChild;
    try {
      child = spawn(file, [target], options);
    } catch (error) {
      reject(openFailed(errnoCode(error) ?? 'spawn'));
      return;
    }
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', (error) => {
      reject(openFailed(errnoCode(error) ?? 'spawn'));
    });
  });
}

/**
 * Shows `target` in the file manager: a file selected in its folder, a folder opened (see the file
 * comment). `target` must be absolute and safe (POSIX rules). Throws OPEN_FAILED.
 */
export async function showInFileManager(
  target: string,
  directory: boolean,
  opts: DesktopOpenOptions = {},
): Promise<void> {
  if (POSIX_PATHS.issue(target) !== null) throw openFailed('path');
  const method = directory ? 'ShowFolders' : 'ShowItems';
  const run = systemRunner(opts.run);
  try {
    const result = await run(
      toolOf(opts)('gdbus'),
      [
        'call',
        '--session',
        '--dest',
        FILE_MANAGER_DEST,
        '--object-path',
        FILE_MANAGER_PATH,
        '--method',
        `${FILE_MANAGER_DEST}.${method}`,
        `['${posixFileUri(target)}']`,
        "''",
      ],
      {
        env: guiEnvironment(opts.env, 'linux'),
        timeoutMs: FILE_MANAGER_TIMEOUT_MS,
        maxOutputBytes: 4 * 1024,
      },
    );
    if (!result.timedOut && result.exitCode === 0) return;
  } catch {
    // gdbus missing or not startable: the folder through xdg-open.
  }
  await xdgOpen(directory ? target : path.posix.dirname(target), opts);
}
