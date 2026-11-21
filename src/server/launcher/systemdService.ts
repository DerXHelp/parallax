/**
 * `parallax service install|uninstall|status` (WP-107, docs/wp/WP-100.md §5.8, WP-101): the server
 * mode as a systemd user service – `~/.config/systemd/user/parallax.service` (respecting
 * `XDG_CONFIG_HOME`) with `ExecStart=… --server`, `systemctl --user enable --now`. A user service
 * stops at logout unless lingering is on; enabling that needs the administrator
 * (`sudo loginctl enable-linger <user>`), so Parallax only checks it and prints the command.
 *
 * Every tool is started by its absolute path (`systemTool`), without a shell, with an argument array.
 * The unit's values are quoted by systemd's rules (`"…"` with `\\`/`\"`, `%` → `%%`, `$` → `$$`).
 * Exported for WP-108 (the autostart setting in server mode steers this service).
 */
import { accessSync, constants } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../lib/fs';
import { fsErrorCode } from '../lib/paths';
import { spawnHidden, systemTool } from '../lib/process';

export const SYSTEMD_UNIT_NAME = 'parallax.service';

/** How long one `systemctl`/`loginctl` call may take. */
export const SYSTEMCTL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface ToolResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a system tool (absolute path) with arguments; never rejects for a non-zero exit. */
export type ToolRunner = (file: string, args: readonly string[]) => Promise<ToolResult>;

export interface ServiceDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Default `os.homedir()`. */
  homeDir?: string;
  /** Default `os.userInfo().username`. */
  userName?: string;
  run?: ToolRunner;
  /** File seams (tests). */
  writeFile?: (file: string, text: string) => Promise<void>;
  readFile?: (file: string) => Promise<string>;
  removeFile?: (file: string) => Promise<void>;
  /** Is `file` an executable program (default: `access(X_OK)`)? */
  isExecutable?: (file: string) => boolean;
  out(line: string): void;
}

function defaultIsExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ServiceUnitOptions {
  /** Absolute program and arguments that start the launcher (main.ts `launcherCommand`). */
  command: readonly string[];
  /** Arguments after `--server` (`--home=…`, `--port=…`, `--key-store=file`). */
  serverArgs: readonly string[];
  /** Working folder (installation root or repo). */
  workDir: string;
  /** PATH of the installing shell: `claude` and its tools are found like in the terminal. */
  path?: string;
}

/** `$XDG_CONFIG_HOME/systemd/user/parallax.service` (default `~/.config/…`). */
export function systemdUnitPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const configHome = env.XDG_CONFIG_HOME;
  const base =
    configHome !== undefined && path.posix.isAbsolute(configHome)
      ? configHome
      : path.posix.join(homeDir, '.config');
  return path.posix.join(base, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

function assertUnitValue(value: string): void {
  if (/[\r\n\0]/u.test(value)) throw new Error('unit value with a line break or NUL');
}

/** One word of `ExecStart=`: always quoted, `\` and `"` escaped, `%` and `$` doubled. */
export function quoteUnitValue(value: string): string {
  assertUnitValue(value);
  const escaped = value
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/%/gu, '%%')
    .replace(/\$/gu, '$$$$');
  return `"${escaped}"`;
}

/**
 * One assignment of `Environment=` (review WP-109): quoted and escaped like `ExecStart=`, `%` doubled –
 * but `$` stays (systemd expands no variables there, `$$` would stay two dollars).
 */
export function quoteEnvironmentValue(value: string): string {
  assertUnitValue(value);
  const escaped = value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/%/gu, '%%');
  return `"${escaped}"`;
}

/**
 * The path of `WorkingDirectory=` (review WP-109): systemd takes the rest of the line as is – quotes
 * make it "not absolute", a fatal error of the unit (checked with `systemd-analyze verify`). Only `%`
 * is doubled (specifiers).
 */
export function unitPathValue(value: string): string {
  assertUnitValue(value);
  if (!value.startsWith('/') || value.trim() !== value) throw new Error('unit path not absolute');
  return value.replace(/%/gu, '%%');
}

/** The unit file (Type=simple: the launcher stays in the foreground with the server). */
export function systemdUnit(options: ServiceUnitOptions): string {
  const exec = [...options.command, '--server', ...options.serverArgs].map(quoteUnitValue).join(' ');
  return [
    '# Written by "parallax service install" - "parallax service uninstall" removes it.',
    '[Unit]',
    'Description=Parallax (server mode)',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${exec}`,
    `WorkingDirectory=${unitPathValue(options.workDir)}`,
    ...(options.path === undefined || options.path === ''
      ? []
      : [`Environment=${quoteEnvironmentValue(`PATH=${options.path}`)}`]),
    'Restart=on-failure',
    'RestartSec=10',
    // Review WP-109: SIGTERM to the launcher only, it passes it on (supervise.ts) and the server ends
    // its sessions itself; whatever is left gets SIGKILL afterwards. With the default (control-group)
    // every process got SIGTERM at once – claude processes in the middle of the server's shutdown.
    'KillMode=mixed',
    // Give the server time before systemd kills.
    'TimeoutStopSec=60',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Real runner: `spawnHidden` with pipes, a deadline, capped output. */
export const runTool: ToolRunner = (file, args) =>
  new Promise<ToolResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawnHidden(file, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      onStderr: (chunk) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
      },
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, SYSTEMCTL_TIMEOUT_MS);
    timer.unref();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: error.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 300) ?? '';
}

interface Resolved {
  run: ToolRunner;
  systemctl: string;
  unitPath: string;
  userName: string;
}

function resolve(deps: ServiceDeps): Resolved | string {
  if (deps.platform !== 'linux')
    return 'The service is for Linux with systemd; on Windows Parallax uses the autostart.';
  const missing = 'systemctl was not found - this Linux has no systemd user services.';
  let systemctl: string;
  try {
    systemctl = systemTool('systemctl', deps.env, deps.platform);
  } catch {
    return missing;
  }
  // Review WP-109: `systemTool` falls back to /usr/bin for a bare name – check before anything is written.
  if (!(deps.isExecutable ?? defaultIsExecutable)(systemctl)) return missing;
  return {
    run: deps.run ?? runTool,
    systemctl,
    unitPath: systemdUnitPath(deps.env, deps.homeDir ?? os.homedir()),
    userName: deps.userName ?? os.userInfo().username,
  };
}

/** Is lingering on (the service also runs without a login)? null = unknown. */
async function lingerOn(deps: ServiceDeps, r: Resolved): Promise<boolean | null> {
  let loginctl: string;
  try {
    loginctl = systemTool('loginctl', deps.env, deps.platform);
  } catch {
    return null;
  }
  const result = await r.run(loginctl, ['show-user', r.userName, '--property=Linger', '--value']);
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value === 'yes' ? true : value === 'no' ? false : null;
}

function lingerHint(deps: ServiceDeps, r: Resolved, on: boolean | null): void {
  if (on === true) {
    deps.out('Lingering is on: the service also runs without a login and after a restart.');
    return;
  }
  deps.out(
    'Note: without lingering the service stops when you log out. To keep it running, an administrator ' +
      `runs once: sudo loginctl enable-linger ${r.userName}`,
  );
}

/** `parallax service install`: writes the unit, reloads, enables and starts it. Exit code. */
export async function installService(options: ServiceUnitOptions, deps: ServiceDeps): Promise<number> {
  const r = resolve(deps);
  if (typeof r === 'string') {
    deps.out(r);
    return 2;
  }
  const text = systemdUnit(options);
  try {
    if (deps.writeFile === undefined) {
      await mkdir(path.dirname(r.unitPath), { recursive: true });
      await writeFileAtomic(r.unitPath, text);
    } else {
      await deps.writeFile(r.unitPath, text);
    }
  } catch (error) {
    deps.out(
      `The unit file ${r.unitPath} could not be written: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  deps.out(`Wrote ${r.unitPath}.`);
  for (const args of [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
  ]) {
    const result = await r.run(r.systemctl, args);
    if (result.exitCode !== 0) {
      deps.out(
        `systemctl ${args.join(' ')} failed: ${firstLine(result.stderr) || `exit ${String(result.exitCode)}`}`,
      );
      return 1;
    }
  }
  deps.out(`The service ${SYSTEMD_UNIT_NAME} is enabled and started.`);
  lingerHint(deps, r, await lingerOn(deps, r));
  deps.out(
    'Sign in from another computer over an SSH tunnel: ssh -L 4711:127.0.0.1:<port> <this computer>, ' +
      'then "parallax --print-url" here for the address.',
  );
  return 0;
}

/** `parallax service uninstall`: stops and disables the service, removes the unit. Exit code. */
export async function uninstallService(deps: ServiceDeps): Promise<number> {
  const r = resolve(deps);
  if (typeof r === 'string') {
    deps.out(r);
    return 2;
  }
  const disable = await r.run(r.systemctl, ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME]);
  // A unit that is not there is fine – the file may still be there.
  if (disable.exitCode !== 0)
    deps.out(`systemctl --user disable --now: ${firstLine(disable.stderr) || 'failed'}`);
  try {
    await (deps.removeFile ?? ((file: string) => rm(file, { force: true })))(r.unitPath);
  } catch (error) {
    deps.out(
      `The unit file ${r.unitPath} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  await r.run(r.systemctl, ['--user', 'daemon-reload']);
  deps.out(`The service ${SYSTEMD_UNIT_NAME} is removed (data folder unchanged).`);
  return 0;
}

/** `parallax service status`: unit file, enabled, active, lingering. Exit 0 = running, 3 = not. */
export async function serviceStatus(deps: ServiceDeps): Promise<number> {
  const r = resolve(deps);
  if (typeof r === 'string') {
    deps.out(r);
    return 2;
  }
  let installed = true;
  try {
    await (deps.readFile ?? ((file: string) => readFile(file, 'utf8')))(r.unitPath);
  } catch (error) {
    if (fsErrorCode(error) !== 'ENOENT') throw error;
    installed = false;
  }
  if (!installed) {
    deps.out(`The service is not installed (${r.unitPath} missing) - "parallax service install".`);
    return 3;
  }
  const enabled =
    firstLine((await r.run(r.systemctl, ['--user', 'is-enabled', SYSTEMD_UNIT_NAME])).stdout) || 'unknown';
  const active =
    firstLine((await r.run(r.systemctl, ['--user', 'is-active', SYSTEMD_UNIT_NAME])).stdout) || 'unknown';
  deps.out(`Service ${SYSTEMD_UNIT_NAME}: ${active}, ${enabled} (${r.unitPath}).`);
  lingerHint(deps, r, await lingerOn(deps, r));
  return active === 'active' ? 0 : 3;
}
