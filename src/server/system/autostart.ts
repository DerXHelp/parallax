/**
 * Autostart shortcut (ADR-110): `Parallax.lnk` in the user's Startup folder
 * (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`, from the given `env` – a temp folder
 * in tests), created and removed by a hidden Windows PowerShell with `WScript.Shell` – the script
 * is constant (`-EncodedCommand`), the data travel in environment variables. Target = the real
 * `node.exe` (`realpath(process.execPath)`: fnm/nvm multishell paths are temporary), arguments =
 * tsx CLI, `--tsconfig`, the launcher's `main.ts` and `--autostart` (one command line,
 * `windowsCommandLine`), working directory = the repo, window minimized (7). Live: L10 (WP-41).
 *
 * `launcherCommand` is also the base of the protocol handler (system/protocol.ts).
 */
import { access, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { windowsPathIssue } from '@shared/paths';
import { PRODUCT_NAME } from '@shared/product';
import { toError } from '../lib/async';
import { windowsCommandLine } from '../lib/cmdline';
import { encodePowerShell, powerShellPath } from '../lib/powershell';
import type { RunFileFn } from '../lib/process';
import { getEnvVar } from '../lib/windows';
import type { SystemOpResult } from './run';

/** How to start the launcher (shortcut target, protocol handler command). */
export interface StartCommand {
  /** Absolute node.exe (realpath of process.execPath). */
  node: string;
  args: string[];
  /** Working directory: the repo root. */
  cwd: string;
}

export interface LauncherCommandOptions {
  /** ≠ null: the server does not run on the default data directory → `--home=<home>` (ADR-110). */
  home?: string | null;
  /** Default `process.execPath`. */
  execPath?: string;
  /** Default `fs.promises.realpath`. */
  realpath?: (file: string) => Promise<string>;
}

/**
 * `realpath(process.execPath)` + `[<repo>\node_modules\tsx\dist\cli.mjs, '--tsconfig',
 * <repo>\src\server\tsconfig.json, <repo>\src\server\launcher\main.ts, (--home=<home>,
 * --system-integration=on,) …extra]`. R4-12: another data directory is only integrated with
 * `--system-integration=on` (`auto` turns it off there) – the server the shortcut or the protocol
 * handler starts gets the same mode, so it can undo the registration through its settings.
 */
export async function launcherCommand(
  repoRoot: string,
  extra: readonly string[],
  opts: LauncherCommandOptions = {},
): Promise<StartCommand> {
  const node = await (opts.realpath ?? realpath)(opts.execPath ?? process.execPath);
  const home = opts.home ?? null;
  return {
    node,
    args: [
      path.win32.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      '--tsconfig',
      path.win32.join(repoRoot, 'src', 'server', 'tsconfig.json'),
      path.win32.join(repoRoot, 'src', 'server', 'launcher', 'main.ts'),
      ...(home === null ? [] : [`--home=${home}`, '--system-integration=on']),
      ...extra,
    ],
    cwd: repoRoot,
  };
}

export const AUTOSTART_LINK_NAME = `${PRODUCT_NAME}.lnk`;
/** `WshShortcut.WindowStyle`: 7 = minimized (the launcher's console only flashes in the taskbar). */
export const AUTOSTART_WINDOW_STYLE = 7;
export const AUTOSTART_TIMEOUT_MS = 30_000;

/** `<APPDATA>\Microsoft\Windows\Start Menu\Programs\Startup\Parallax.lnk`, or null without a safe APPDATA. */
export function autostartLinkPath(env: NodeJS.ProcessEnv): string | null {
  const appData = getEnvVar(env, 'APPDATA');
  if (appData === undefined || windowsPathIssue(appData) !== null) return null;
  return path.win32.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    AUTOSTART_LINK_NAME,
  );
}

/**
 * Marks a start command as Parallax's own (case-insensitive): the launcher's `main.ts` in the
 * arguments – shortcut (R4-11) and protocol handler (system/protocol.ts).
 */
export const LAUNCHER_MARKER = 'launcher\\main.ts';

/** The variables the script reads. */
export const AUTOSTART_ENV = {
  action: 'PARALLAX_LNK_ACTION',
  path: 'PARALLAX_LNK_PATH',
  target: 'PARALLAX_LNK_TARGET',
  args: 'PARALLAX_LNK_ARGS',
  cwd: 'PARALLAX_LNK_CWD',
  description: 'PARALLAX_LNK_DESCRIPTION',
  /** R4-11/CR2-03: `LAUNCHER_MARKER` – a shortcut without it in its arguments is neither removed nor replaced. */
  marker: 'PARALLAX_LNK_MARKER',
} as const;

/**
 * Output of the script for a shortcut that belongs to the user or another program (R4-11): the
 * removal leaves it alone (`ok`), the creation refuses to replace it (CR2-03, `reason: 'foreign'`).
 */
export const FOREIGN_SHORTCUT = 'foreign';

/**
 * The constant script: create (WScript.Shell) or remove the shortcut; exit 3 with the reason. An
 * existing shortcut is read first and left alone (`foreign`) unless its arguments contain the
 * marker – for both actions (R4-11: e.g. a `Parallax.lnk` the user made on `parallax.cmd` in
 * Phase 1; CR2-03/ADR-133: creating must not replace it, or turning autostart off would delete it later).
 */
export const AUTOSTART_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  `  $path = $env:${AUTOSTART_ENV.path}`,
  '  $shell = New-Object -ComObject WScript.Shell',
  '  if (Test-Path -LiteralPath $path) {',
  '    $existing = $shell.CreateShortcut($path)',
  `    $marker = ([string]$env:${AUTOSTART_ENV.marker}).ToLowerInvariant()`,
  '    if (-not $marker -or -not ([string]$existing.Arguments).ToLowerInvariant().Contains($marker)) {',
  `      Write-Output '${FOREIGN_SHORTCUT}'`,
  '      exit 0',
  '    }',
  '  }',
  `  if ($env:${AUTOSTART_ENV.action} -eq 'remove') {`,
  '    if (Test-Path -LiteralPath $path) {',
  '      Remove-Item -LiteralPath $path -Force',
  '    }',
  "    Write-Output 'removed'",
  '    exit 0',
  '  }',
  '  $link = $shell.CreateShortcut($path)',
  `  $link.TargetPath = $env:${AUTOSTART_ENV.target}`,
  `  $link.Arguments = $env:${AUTOSTART_ENV.args}`,
  `  $link.WorkingDirectory = $env:${AUTOSTART_ENV.cwd}`,
  `  $link.WindowStyle = ${String(AUTOSTART_WINDOW_STYLE)}`,
  `  $link.Description = $env:${AUTOSTART_ENV.description}`,
  '  $link.Save()',
  "  Write-Output 'created'",
  '  exit 0',
  '} catch {',
  "  Write-Output ('error: ' + $_.Exception.Message)",
  '  exit 3',
  '}',
].join('\n');

export interface ShortcutOptions {
  run: RunFileFn;
  /** Base environment of the PowerShell process (SystemRoot, …). */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Runs the script with `vars`: an output ending in an `expected` word is success, one ending in a
 * `refused` word a failure with that word as the reason (exit 0 both).
 */
async function runShortcutScript(
  vars: Record<string, string>,
  expected: readonly string[],
  opts: ShortcutOptions,
  refused: readonly string[] = [],
): Promise<SystemOpResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith('PARALLAX_LNK_')) env[key] = value;
  }
  Object.assign(env, vars);
  try {
    // R4-04: no `-ExecutionPolicy` – an `-EncodedCommand` is not subject to it.
    const result = await opts.run(
      powerShellPath(opts.env),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(AUTOSTART_SCRIPT)],
      { env, timeoutMs: opts.timeoutMs ?? AUTOSTART_TIMEOUT_MS, maxOutputBytes: 16 * 1024 },
    );
    if (result.timedOut) return { ok: false, reason: 'timeout' };
    const output = result.stdout.trim();
    if (result.exitCode === 0 && expected.some((word) => output.endsWith(word))) return { ok: true };
    const refusal = refused.find((word) => output.endsWith(word));
    if (result.exitCode === 0 && refusal !== undefined) return { ok: false, reason: refusal };
    return {
      ok: false,
      reason: `exit ${String(result.exitCode)}: ${(output || result.stderr.trim()).slice(0, 300)}`,
    };
  } catch (error) {
    return { ok: false, reason: `powershell could not be started: ${toError(error).message}` };
  }
}

/**
 * Creates the shortcut `link` for `command` or replaces the own one (Startup folder created if
 * missing); a shortcut without `LAUNCHER_MARKER` in its arguments belongs to someone else and is
 * never replaced (CR2-03: `{ ok: false, reason: FOREIGN_SHORTCUT }`, consistent with R4-11).
 */
export async function createAutostartShortcut(
  link: string,
  command: StartCommand,
  opts: ShortcutOptions,
): Promise<SystemOpResult> {
  try {
    await mkdir(path.win32.dirname(link), { recursive: true });
  } catch (error) {
    return { ok: false, reason: `startup folder: ${toError(error).message}` };
  }
  return runShortcutScript(
    {
      [AUTOSTART_ENV.action]: 'create',
      [AUTOSTART_ENV.path]: link,
      [AUTOSTART_ENV.target]: command.node,
      [AUTOSTART_ENV.args]: windowsCommandLine(command.args),
      [AUTOSTART_ENV.cwd]: command.cwd,
      [AUTOSTART_ENV.description]: PRODUCT_NAME,
      [AUTOSTART_ENV.marker]: LAUNCHER_MARKER,
    },
    ['created'],
    opts,
    [FOREIGN_SHORTCUT],
  );
}

/**
 * Removes the own shortcut `link` (a missing one is fine); one whose arguments do not start the
 * launcher (`LAUNCHER_MARKER`) belongs to someone else and stays (R4-11, also `ok`).
 */
export function removeAutostartShortcut(link: string, opts: ShortcutOptions): Promise<SystemOpResult> {
  return runShortcutScript(
    { [AUTOSTART_ENV.action]: 'remove', [AUTOSTART_ENV.path]: link, [AUTOSTART_ENV.marker]: LAUNCHER_MARKER },
    ['removed', FOREIGN_SHORTCUT],
    opts,
  );
}

/** Does the shortcut exist (a plain `access`, no PowerShell)? */
export async function autostartLinkExists(link: string): Promise<boolean> {
  try {
    await access(link);
    return true;
  } catch {
    return false;
  }
}
