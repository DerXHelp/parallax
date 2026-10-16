/**
 * Visible console window for `claude --resume <id>` (ADR-104; port `ConsoleLauncher`,
 * system/ports.ts). Node/libuv always hands std handles to a spawned child (a directly started
 * claude.exe would get NUL instead of a console) and `detached` means DETACHED_PROCESS (no console
 * at all); `cmd /c start` is forbidden (C.10). So a hidden Windows PowerShell (absolute System32
 * path, no shell, `windowsHide`) runs a CONSTANT script (`-EncodedCommand`) whose
 * `Start-Process -PassThru` opens the console. The data travel only in environment variables:
 * `PARALLAX_CONSOLE_EXE`, `_ARGS` (one command line, `windowsCommandLine`), `_CWD`; the script
 * removes them from its own environment first, so claude.exe inherits exactly
 * `ConsoleLaunchSpec.env` (built by buildEnv: profile env, CLAUDE_CONFIG_DIR, PARALLAX=1,
 * PARALLAX_ENTRY_ID). Output `pid=<n>;start=<ISO>`; any failure → exit 3 with the reason →
 * `{kind: 'failed', reason}`. Never throws.
 *
 * `state()`: `isProcessAlive(pid)` (gone → `ended`); with a known start time also the exact
 * creation time (± 5 s, PID reuse → `ended`); a failed query → `unknown` (never counts as ended,
 * ADR-051). Live (L6): Windows Terminal as the default terminal, AppLocker/CLM → WP-41.
 */
import { windowsPathIssue } from '@shared/paths';
import type { ConsoleLaunchSpec } from '../claude/ports';
import { toError } from '../lib/async';
import { windowsCommandLine } from '../lib/cmdline';
import { POWERSHELL_UTC_ISO_FORMAT, encodePowerShell, powerShellPath } from '../lib/powershell';
import { assertSpawnableFile, isProcessAlive, processStartTime, type RunFileFn } from '../lib/process';
import type { ConsoleLauncher, ConsoleOpenResult, ConsoleProcess } from './ports';
import { systemRunner } from './run';

/** PowerShell start + Start-Process: ~1 s idle, much more under load. */
export const CONSOLE_TIMEOUT_MS = 30_000;
/** Tolerance of the start time comparison (PID reuse check, like the orphan cleanup). */
export const CONSOLE_START_TOLERANCE_MS = 5_000;
/** Exit code of the script when anything fails. */
export const CONSOLE_EXIT_FAILED = 3;

/** The variables the script reads (and removes from its own environment). */
export const CONSOLE_ENV = {
  exe: 'PARALLAX_CONSOLE_EXE',
  args: 'PARALLAX_CONSOLE_ARGS',
  cwd: 'PARALLAX_CONSOLE_CWD',
} as const;

/** The constant script (data only from the environment, see the file comment). */
export const CONSOLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  `  $exe = $env:${CONSOLE_ENV.exe}`,
  `  $line = $env:${CONSOLE_ENV.args}`,
  `  $cwd = $env:${CONSOLE_ENV.cwd}`,
  `  foreach ($name in '${CONSOLE_ENV.exe}', '${CONSOLE_ENV.args}', '${CONSOLE_ENV.cwd}') {`,
  "    Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue",
  '  }',
  '  if ($line) {',
  '    $p = Start-Process -FilePath $exe -ArgumentList $line -WorkingDirectory $cwd -PassThru',
  '  } else {',
  '    $p = Start-Process -FilePath $exe -WorkingDirectory $cwd -PassThru',
  '  }',
  "  $start = ''",
  `  try { $start = $p.StartTime.ToUniversalTime().ToString("${POWERSHELL_UTC_ISO_FORMAT}") } catch { }`,
  "  Write-Output ('pid=' + $p.Id + ';start=' + $start)",
  '  exit 0',
  '} catch {',
  "  Write-Output ('error: ' + $_.Exception.Message)",
  `  exit ${String(CONSOLE_EXIT_FAILED)}`,
  '}',
].join('\n');

export interface ConsoleLauncherOptions {
  /** Default `runFile` – never in a test run (system/run.ts). */
  run?: RunFileFn;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** Default `isProcessAlive`. */
  isAlive?: (pid: number) => boolean;
  /** Exact creation time of `pid`; null = unknown (default `processStartTime` through `run`). */
  startTime?: (pid: number) => Promise<Date | null>;
}

/** `pid=<n>;start=<ISO or empty>` → the process, or null for anything else. */
export function parseConsoleOutput(stdout: string): ConsoleProcess | null {
  const match = /pid=(\d+);start=(\S*)/.exec(stdout);
  if (match === null) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const start = match[2] ?? '';
  const time = start === '' ? Number.NaN : Date.parse(start);
  return { pid, startedAt: Number.isNaN(time) ? null : new Date(time) };
}

function failed(reason: string): ConsoleOpenResult {
  return { kind: 'failed', reason: reason.slice(0, 500) };
}

export function createConsoleLauncher(opts: ConsoleLauncherOptions = {}): ConsoleLauncher {
  const run = systemRunner(opts.run);
  const platform = opts.platform ?? process.platform;
  const isAlive = opts.isAlive ?? isProcessAlive;
  const startTime = opts.startTime ?? ((pid: number) => processStartTime(pid, { run, platform }));

  return {
    open: async (spec: ConsoleLaunchSpec): Promise<ConsoleOpenResult> => {
      if (platform !== 'win32') return failed('not Windows');
      try {
        assertSpawnableFile(spec.executablePath, 'win32');
      } catch (error) {
        return failed(toError(error).message);
      }
      const cwdIssue = windowsPathIssue(spec.cwd);
      if (cwdIssue !== null) return failed(`working directory rejected (${cwdIssue})`);
      const env: Record<string, string> = {
        ...spec.env,
        [CONSOLE_ENV.exe]: spec.executablePath,
        [CONSOLE_ENV.args]: windowsCommandLine(spec.args),
        [CONSOLE_ENV.cwd]: spec.cwd,
      };
      try {
        const result = await run(
          powerShellPath(),
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            encodePowerShell(CONSOLE_SCRIPT),
          ],
          { env, timeoutMs: opts.timeoutMs ?? CONSOLE_TIMEOUT_MS, maxOutputBytes: 16 * 1024 },
        );
        if (result.timedOut) return failed('timeout');
        const output = result.stdout.trim();
        const opened = result.exitCode === 0 ? parseConsoleOutput(output) : null;
        if (opened !== null) return { kind: 'opened', process: opened };
        return failed(`exit ${String(result.exitCode)}: ${output || result.stderr.trim()}`);
      } catch (error) {
        return failed(`powershell could not be started: ${toError(error).message}`);
      }
    },

    state: async (proc) => {
      if (proc.pid === null) return 'unknown';
      try {
        if (!isAlive(proc.pid)) return 'ended';
        if (proc.startedAt === null) return 'running';
        const actual = await startTime(proc.pid);
        if (actual === null) return 'unknown';
        return Math.abs(actual.getTime() - proc.startedAt.getTime()) <= CONSOLE_START_TOLERANCE_MS
          ? 'running'
          : 'ended';
      } catch {
        return 'unknown';
      }
    },
  };
}
