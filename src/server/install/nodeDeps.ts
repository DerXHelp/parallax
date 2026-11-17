/**
 * The real dependencies of the installer flow (WP-86): SDK from cache/npm/registry, the Start menu
 * entry and the removal of the entries (system/installation.ts, behind the R6 guard of the system
 * integration), the running server of the default data directory, the pipe lock per root and
 * `node.exe` with this console. main.ts uses them for dist/install.js; `scripts/release/smoke.ts`
 * for the unsigned trial (with its own environment).
 */
import { once } from 'node:events';
import os from 'node:os';
import { isWindowsPathInside } from '@shared/paths';
import { defaultHome } from '../config';
import { acquireDirectoryLock } from '../lib/homeLock';
import { spawnHidden } from '../lib/process';
import { findRunningServer } from '../launcher/client';
import { ensureStartMenuEntry, removeInstallationEntries } from '../system/installation';
import type { InstallerCliDeps } from './cli';
import { provideSdk } from './sdk';

export interface NodeInstallerOptions {
  /** Default `process.env` (APPDATA/LOCALAPPDATA decide the Start menu and the data directory). */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  ownDir: string;
  installerScript: string;
  /** Default `process.execArgv`. */
  execArgv?: readonly string[];
  /** Only the unsigned trial of the smoke test. */
  keys?: readonly string[];
  out: (line: string) => void;
  fail: (line: string) => void;
}

/** `node.exe <args>` with this console (stdio inherited, hidden window flag, no shell). */
async function runNode(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawnHidden(process.execPath, [...args], { stdio: 'inherit', env });
  const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  return code ?? 1;
}

export function createNodeInstallerDeps(options: NodeInstallerOptions): InstallerCliDeps {
  const env = options.env ?? process.env;
  const home = defaultHome(env);
  const runningBuildId = async (): Promise<string | null> => {
    const found = await findRunningServer({ home });
    return found.kind === 'running' ? found.health.buildId : null;
  };
  return {
    env,
    cwd: options.cwd ?? process.cwd(),
    ownDir: options.ownDir,
    installerScript: options.installerScript,
    execArgv: options.execArgv ?? process.execArgv,
    runNode: (args) => runNode(args, env),
    lockRoot: async (root) => {
      const result = await acquireDirectoryLock('install', root);
      if (result.kind === 'busy') return null;
      const lock = result.lock;
      return { release: () => lock.release() };
    },
    steps: (root) => ({
      provideSdk: async (request) => (await provideSdk({ ...request, env, log: options.out })).source,
      startMenu: async (installRoot) => {
        const result = await ensureStartMenuEntry({ installRoot, env });
        return result.ok ? null : result.reason;
      },
      runningBuildId,
      log: options.out,
      removeEntries: async () => {
        const removal = await removeInstallationEntries({ installRoot: root, env });
        const problems: string[] = [];
        const steps = [
          ['autostart', removal.autostart],
          ['protocol handler', removal.protocol],
          ['Start menu', removal.startMenu],
        ] as const;
        for (const [name, result] of steps) {
          if (!result.ok) problems.push(`${name}: ${result.reason}`);
        }
        return problems;
      },
    }),
    dataDir: home,
    leave: (root) => {
      if (isWindowsPathInside(process.cwd(), root)) process.chdir(os.tmpdir());
    },
    ...(options.keys === undefined ? {} : { keys: options.keys }),
    out: options.out,
    fail: options.fail,
  };
}
