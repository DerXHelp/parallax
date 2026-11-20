/**
 * Host commands of "Open shell in folder" (WP-97, ADR-238):
 *
 * - `session.openShell {entryId, shell}`: cmd, PowerShell or Git Bash as a VISIBLE window in the
 *   entry's cwd. The window opens through the `ConsoleLauncher` of the external console (ADR-104:
 *   hidden Windows PowerShell, constant script, `Start-Process -WorkingDirectory`, data only in
 *   environment variables) – `spawnGui` starts GUI programs only, and a console program started
 *   by Node directly would get no console (libuv std handles, DETACHED_PROCESS). Routed like a host
 *   command: no lifecycle gate (a sleeping, archived or external entry has a folder too), nothing
 *   tracked afterwards. Checks: entry known (ENTRY_NOT_FOUND), `checkCwd` (PATH_REJECTED,
 *   CWD_NOT_FOUND, CWD_NOT_DIRECTORY), Git for Windows for `gitbash` (SHELL_NOT_FOUND); a launcher
 *   failure → SHELL_OPEN_FAILED {reason} (scrubbed like the external console's).
 * - `shell.detect`: the Git for Windows folder for the settings (fresh lookup).
 *
 * Both are in REMOTE_DENIED_COMMANDS: a window of another computer never opens a shell here.
 * `createRecordingShellLauncher` opens NOTHING and logs `session.openShell (fake): <exe> <args>` –
 * compose wires it with the FakeBackend (dev, E2E), like the recording file opener.
 */
import type { Logger } from 'pino';
import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import type { Settings } from '@shared/model';
import type { ConsoleLaunchSpec } from '../claude/ports';
import { logger as rootLogger } from '../lib/logger';
import { checkCwd as defaultCheckCwd } from '../lib/paths';
import { regKeyQuery as defaultRegKeyQuery, type RegKeyQuery } from '../lib/registry';
import { nodeFsProbe, type FsProbe } from '../lib/windows';
import { scrubConsoleReason } from '../sessions/external';
import { CommandError, type HostCommandHandler } from '../sync/ports';
import type { ConsoleLauncher } from '../system/ports';
import { createGitFinder, resolveShellLaunch, type GitFinder, type GitLocatorDeps } from './shells';

export interface ShellCommandsDeps {
  /** The stored cwd of an entry (exactly as stored), null = unknown entry. */
  entryCwd(entryId: EntryId): string | null;
  settings(): Settings;
  launcher: ConsoleLauncher;
  /** Base environment of the shells (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  fs?: FsProbe;
  regKeyQuery?: RegKeyQuery;
  checkCwd?: (cwd: string) => Promise<void>;
  gitFinder?: GitFinder;
}

export function createShellCommands(deps: ShellCommandsDeps): HostCommandHandler {
  const env = deps.env ?? process.env;
  const finder = deps.gitFinder ?? createGitFinder();
  const checkCwd = deps.checkCwd ?? ((cwd: string) => defaultCheckCwd(cwd));
  let registry: RegKeyQuery | null = deps.regKeyQuery ?? null;
  const locator = (): GitLocatorDeps => {
    registry ??= defaultRegKeyQuery();
    return { fs: deps.fs ?? nodeFsProbe, env, regKeyQuery: registry };
  };

  return {
    names: ['session.openShell', 'shell.detect'],
    async handle(cmd) {
      if (cmd.name === 'shell.detect') {
        return { gitDir: await finder.refresh(deps.settings().console.gitDir, locator()) };
      }
      if (cmd.name !== 'session.openShell') {
        throw new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }));
      }
      const cwd = deps.entryCwd(cmd.entryId);
      if (cwd === null) throw new CommandError(makeError('ENTRY_NOT_FOUND'));
      await checkCwd(cwd);
      const settings = deps.settings().console;
      const launch = await resolveShellLaunch(cmd.shell, cwd, settings, 'window', {
        env,
        gitDir: () => finder.find(settings.gitDir, locator()),
      });
      const spec: ConsoleLaunchSpec = {
        executablePath: launch.executablePath,
        args: launch.args,
        env: launch.env,
        explicitEnv: {},
        cwd,
      };
      const result = await deps.launcher.open(spec);
      if (result.kind === 'failed') {
        throw new CommandError(
          makeError('SHELL_OPEN_FAILED', { reason: scrubConsoleReason(result.reason, spec) }),
        );
      }
      return { pid: result.process.pid };
    },
  };
}

export interface RecordingShellLauncher extends ConsoleLauncher {
  readonly opened: readonly ConsoleLaunchSpec[];
}

/** Opens nothing; logs `session.openShell (fake): <exe> <args>` (FakeBackend: dev, E2E). */
export function createRecordingShellLauncher(options: { logger?: Logger } = {}): RecordingShellLauncher {
  const log = (options.logger ?? rootLogger).child({ module: 'terminal.shell' });
  const opened: ConsoleLaunchSpec[] = [];
  return {
    opened,
    open(spec) {
      opened.push(spec);
      log.info(`session.openShell (fake): ${[spec.executablePath, ...spec.args].join(' ')}`);
      return Promise.resolve({ kind: 'opened', process: { pid: null, startedAt: null } });
    },
    state: () => Promise.resolve('ended'),
  };
}
