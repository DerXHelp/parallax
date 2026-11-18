/**
 * Check `firewall` (docs/wp/WP-75.md §4.2): is there an enabled inbound rule for the running
 * `node.exe`? Only READS the Windows firewall (`Get-NetFirewall*`), never changes it – without a rule
 * Windows asks on the first listen, and allowing it may need administrator rights; the UI only
 * explains that. The result is a hint (`ok`/`warning`), never an error.
 *
 * Windows PowerShell 5.1 with a constant script (`-EncodedCommand`); the program path travels in an
 * environment variable (lib/powershell.ts convention), absolute System32 path, hidden, no shell.
 */
import { encodePowerShell } from '../lib/powershell';
import { powerShellPath, runFile, windowsPowerShellEnv, type RunFileFn } from '../lib/process';

export const FIREWALL_TIMEOUT_MS = 20_000;
export const FIREWALL_PROGRAM_ENV = 'PARALLAX_FIREWALL_PROGRAM';

/** Prints `<enabled inbound allow rules> <enabled inbound block rules>`; only Get-* cmdlets. */
export const FIREWALL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $program = $env:PARALLAX_FIREWALL_PROGRAM
  if ([string]::IsNullOrEmpty($program)) { exit 3 }
  $filters = @(Get-NetFirewallApplicationFilter -Program $program -ErrorAction SilentlyContinue)
  $rules = @()
  if ($filters.Count -gt 0) {
    $rules = @($filters | Get-NetFirewallRule -ErrorAction SilentlyContinue |
      Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' })
  }
  $allow = @($rules | Where-Object { $_.Action -eq 'Allow' }).Count
  $block = @($rules | Where-Object { $_.Action -eq 'Block' }).Count
  [Console]::Out.Write([string]$allow + ' ' + [string]$block)
  exit 0
} catch {
  exit 2
}
`;

const FIREWALL_ARGS: readonly string[] = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  encodePowerShell(FIREWALL_SCRIPT),
];

export type FirewallState =
  { kind: 'allowed' } | { kind: 'blocked' } | { kind: 'no_rule' } | { kind: 'unknown' };

export interface FirewallCheckOptions {
  platform?: NodeJS.Platform;
  run?: RunFileFn;
  /** The program the rule must be for (default: the running node.exe). */
  program?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Reads the firewall rules for the program. Never throws. */
export async function checkFirewall(options: FirewallCheckOptions = {}): Promise<FirewallState> {
  if ((options.platform ?? process.platform) !== 'win32') return { kind: 'unknown' };
  const run = options.run ?? runFile;
  try {
    const env = windowsPowerShellEnv(options.env);
    env[FIREWALL_PROGRAM_ENV] = options.program ?? process.execPath;
    const result = await run(powerShellPath(options.env), FIREWALL_ARGS, {
      env,
      timeoutMs: options.timeoutMs ?? FIREWALL_TIMEOUT_MS,
      maxOutputBytes: 1024,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.timedOut || result.exitCode !== 0) return { kind: 'unknown' };
    const match = /^(\d{1,6}) (\d{1,6})$/u.exec(result.stdout.trim());
    if (match === null) return { kind: 'unknown' };
    const allow = Number(match[1]);
    const block = Number(match[2]);
    if (block > 0) return { kind: 'blocked' };
    return allow > 0 ? { kind: 'allowed' } : { kind: 'no_rule' };
  } catch {
    return { kind: 'unknown' };
  }
}

/** The arguments (constant) – for the test that the script only reads. */
export function firewallArgs(): readonly string[] {
  return FIREWALL_ARGS;
}
