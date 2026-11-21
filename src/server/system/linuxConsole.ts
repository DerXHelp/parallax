/**
 * Visible console window on a Linux desktop (WP-106, WP-100 §5.5; port `ConsoleLauncher`): the
 * external console (`claude --resume …`, ADR-104) and the window of "Open shell in folder" (WP-97)
 * open in a terminal emulator (system/terminalEmulator.ts: setting → `xdg-terminal-exec` →
 * `x-terminal-emulator` → known ones). The emulator is started without a shell (argument array,
 * absolute program), in the spec's working folder, with exactly the spec's environment (built by
 * `buildEnv`: `PARALLAX=1`, `PARALLAX_ENTRY_ID`, profile env) – it hands it on to the command.
 *
 * Which process is the console: terminal emulators return at once (GNOME Terminal, Ptyxis, Konsole
 * hand the window to a running server process), so the PID of the started program says nothing.
 * The launcher searches `/proc` instead (WP-101 §1.4): a process of this user whose environment has
 * the spec's `PARALLAX_ENTRY_ID`, whose `argv[0]` is the spec's program and which started after the
 * click (`btime` has only seconds: `LINUX_CONSOLE_START_SLACK_MS` slack) – the oldest such process,
 * polled every `LINUX_CONSOLE_POLL_MS` for up to `LINUX_CONSOLE_FIND_MS`. Not found: an emulator that
 * runs the command as its own child and is still open (xterm, foot, kitty, Alacritty) hosts it – its
 * PID is watched; otherwise `failed`. A spec without `PARALLAX_ENTRY_ID` (the shell window, never
 * tracked) is `opened` with an unknown process right after the start.
 *
 * `state()` is the Windows check over `/proc` (alive + start time ± 5 s, system/console.ts).
 * Without a terminal emulator the preflight (`consolePreflight`) refuses BEFORE the SDK query closes.
 * A test run never starts anything (`systemSpawner`, `systemEnv`; system/run.ts, R6). Never throws.
 */
import path from 'node:path';
import { POSIX_PATHS } from '@shared/paths';
import type { ConsoleLaunchSpec } from '../claude/ports';
import { sleep as realSleep, toError } from '../lib/async';
import { createProcfsReader, isEndedState, type ProcfsReader } from '../lib/procfs';
import { nodeFsProbe, type FsProbe } from '../lib/windows';
import {
  consoleFailed,
  createConsoleStateCheck,
  withConsolePreflight,
  type ConsoleStateOptions,
} from './console';
import type { ConsoleLauncher, ConsoleOpenResult, ConsoleProcess } from './ports';
import { systemEnv, systemSpawner, type SystemSpawnFn } from './run';
import { resolveTerminalEmulator, terminalCommandArgs, type TerminalEmulator } from './terminalEmulator';

/** How long the console process is searched after the emulator started. */
export const LINUX_CONSOLE_FIND_MS = 15_000;
export const LINUX_CONSOLE_POLL_MS = 250;
/** `/proc` start times are only exact to the second (WP-101 §1.4). */
export const LINUX_CONSOLE_START_SLACK_MS = 1_500;
/** `failed.reason` without a usable terminal emulator (also the preflight's answer). */
export const NO_TERMINAL_EMULATOR = 'no terminal emulator found';

export interface LinuxConsoleLauncherOptions extends ConsoleStateOptions {
  /** `settings().console.terminalEmulator` at the time of the click (default: detect). */
  terminalEmulator?: () => string | null;
  /** `PATH` of the emulator lookup (default `process.env` – never in a test run, system/run.ts). */
  env?: NodeJS.ProcessEnv;
  /** Lookup of the emulator (default the guarded real file system). */
  fs?: FsProbe;
  /** Start of the emulator (default `spawnHidden` – never in a test run). */
  spawn?: SystemSpawnFn;
  /** The process table (default `/proc`). */
  procfs?: ProcfsReader;
  findTimeoutMs?: number;
  pollMs?: number;
  /** Clock and wait of the search (tests). */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The console process of `entryId` started from `executable` at or after `since` (see the file
 * comment), or null. The oldest wins (claude's own children carry the same environment).
 */
export function findConsoleProcess(
  reader: ProcfsReader,
  target: { entryId: string; executable: string; since: Date },
): ConsoleProcess | null {
  const table = reader.table();
  if (table === null) return null;
  const base = path.posix.basename(target.executable);
  let best: { pid: number; startedAt: Date } | null = null;
  for (const row of table) {
    if (isEndedState(row.state)) continue;
    const startedAt = reader.startedAt(row);
    if (startedAt === null || startedAt.getTime() < target.since.getTime()) continue;
    const argv0 = reader.commandLine(row.pid)?.[0];
    if (argv0 === undefined || (argv0 !== target.executable && path.posix.basename(argv0) !== base)) continue;
    if (reader.environment(row.pid)?.PARALLAX_ENTRY_ID !== target.entryId) continue;
    const older =
      best === null ||
      startedAt.getTime() < best.startedAt.getTime() ||
      (startedAt.getTime() === best.startedAt.getTime() && row.pid < best.pid);
    if (older) best = { pid: row.pid, startedAt };
  }
  return best;
}

/** How the started emulator ended so far (set by its `exit` event). */
interface EmulatorStatus {
  pid: number | null;
  exited: boolean;
  code: number | null;
}

export function createLinuxConsoleLauncher(opts: LinuxConsoleLauncherOptions = {}): ConsoleLauncher {
  const env = systemEnv(opts.env);
  const spawn = systemSpawner(opts.spawn);
  const fs = opts.fs ?? nodeFsProbe;
  const reader = opts.procfs ?? createProcfsReader();
  const configured = opts.terminalEmulator ?? (() => null);
  const findMs = opts.findTimeoutMs ?? LINUX_CONSOLE_FIND_MS;
  const pollMs = opts.pollMs ?? LINUX_CONSOLE_POLL_MS;
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? realSleep;

  const emulatorOf = (): Promise<TerminalEmulator | null> =>
    resolveTerminalEmulator({ configured: configured(), env, fs }).catch(() => null);

  /** Starts the emulator; resolves once it runs (its `exit` keeps updating `status`). */
  const start = (emulator: TerminalEmulator, spec: ConsoleLaunchSpec, status: EmulatorStatus) =>
    new Promise<void>((resolve, reject) => {
      const args = terminalCommandArgs(emulator.kind, spec.cwd, [spec.executablePath, ...spec.args]);
      const child = spawn(emulator.file, args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: 'ignore',
        detached: true,
      });
      status.pid = child.pid ?? null;
      child.once('exit', (code) => {
        status.exited = true;
        status.code = code;
      });
      child.once('error', (error) => {
        reject(error);
      });
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });

  const launcher: ConsoleLauncher = {
    open: async (spec: ConsoleLaunchSpec): Promise<ConsoleOpenResult> => {
      const programIssue = POSIX_PATHS.issue(spec.executablePath);
      if (programIssue !== null) return consoleFailed(`program rejected (${programIssue})`);
      const cwdIssue = POSIX_PATHS.issue(spec.cwd);
      if (cwdIssue !== null) return consoleFailed(`working directory rejected (${cwdIssue})`);
      const emulator = await emulatorOf();
      if (emulator === null) return consoleFailed(NO_TERMINAL_EMULATOR);
      const since = new Date(clock() - LINUX_CONSOLE_START_SLACK_MS);
      const status: EmulatorStatus = { pid: null, exited: false, code: null };
      try {
        await start(emulator, spec, status);
      } catch (error) {
        return consoleFailed(`terminal emulator could not be started: ${toError(error).message}`);
      }
      const entryId = spec.env.PARALLAX_ENTRY_ID;
      if (entryId === undefined || entryId === '') {
        return { kind: 'opened', process: { pid: null, startedAt: null } };
      }
      const deadline = clock() + findMs;
      for (;;) {
        const found = findConsoleProcess(reader, { entryId, executable: spec.executablePath, since });
        if (found !== null) return { kind: 'opened', process: found };
        if (status.exited && status.code !== 0) {
          return consoleFailed(`terminal emulator exit ${String(status.code)}`);
        }
        if (clock() >= deadline) break;
        await sleep(pollMs);
      }
      // An emulator that runs the command as its own child and is still open hosts the console.
      const pid = status.pid;
      if (!status.exited && pid !== null) {
        const row = reader.stat(pid);
        if (row !== null && !isEndedState(row.state)) {
          return { kind: 'opened', process: { pid, startedAt: reader.startedAt(row) } };
        }
      }
      return consoleFailed('console process not found');
    },
    state: createConsoleStateCheck({ ...opts, platform: 'linux' }),
  };
  return withConsolePreflight(launcher, async () =>
    (await emulatorOf()) === null ? NO_TERMINAL_EMULATOR : null,
  );
}
