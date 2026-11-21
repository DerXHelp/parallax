/**
 * Shells of "Open shell in folder" (WP-97, ADR-238): what starts for `cmd`, `powershell` and
 * `gitbash`, with which arguments and environment. The embedded terminal (WP-99) uses the same
 * resolution in mode `embedded`.
 *
 * - cmd: `%SystemRoot%\System32\cmd.exe`; PowerShell: Windows PowerShell 5.1 (`powerShellPath`,
 *   `-NoLogo`, the user's profile loads like in any new window). Both always exist.
 * - Git Bash: the Git for Windows folder (holds `git-bash.exe`). Window `mintty`: `git-bash.exe
 *   "--cd=<cwd>"` like the Explorer entry "Open Git Bash here" (a drive root `D:\` gets a `.` so the
 *   quoted argument never ends in a backslash). Window `terminal` and the embedded terminal:
 *   `bin\bash.exe --login -i` with `CHERE_INVOKING=1`. Git for Windows keeps the `cwd` without it
 *   too (checked 20.11.2026); MSYS2-style profiles change to `$HOME` unless it is set.
 * - Environment (decision of the user, 20.11.2026): NEUTRAL – the server's environment without the
 *   variables of a calling Claude session, every `PARALLAX*` and the `pnpm run` state
 *   (`guiEnvironment`) and without `node_modules\.bin` in PATH. No profile env, no
 *   `CLAUDE_CONFIG_DIR`: a `claude` typed there uses the user's normal account.
 *
 * Git lookup (quiet sources first, so the usual case starts no `reg.exe`): the folder from the
 * settings → `%ProgramFiles%\Git` → `%LOCALAPPDATA%\Programs\Git` → the folder of `git.exe` on PATH
 * (`<Git>\cmd\git.exe`, one or two levels up) → Uninstall key `Git_is1` → `InstallLocation` (HKCU,
 * HKLM 64/32 bit). Every candidate must be a safe absolute path with an existing `git-bash.exe` and
 * `bin\bash.exe`; registry values are never trusted beyond that. A hit is reused for a minute
 * (`createGitFinder`, like the editor lookup, R5-04).
 *
 * Linux (WP-105, WP-100 §5.4): `login` = the user's login shell – `$SHELL`, else the shell of the
 * user's passwd entry (`os.userInfo()`, through NSS like `getent passwd`), else `/bin/bash`, `/bin/sh`;
 * every candidate absolute, safe by the POSIX rules (also after `realpath`), executable and no
 * `nologin`/`false`. `bash`, `zsh`, `fish`, `pwsh` from PATH (`resolveExecutable`, never the cwd).
 * All of them start as login shells (`-l`; fish `--login`; pwsh `-Login -NoLogo`), in the window
 * (terminal emulator, WP-106) and embedded alike: `~/.profile` adds what the server's environment
 * may lack (`~/.local/bin` of a server started by the desktop or systemd). The Windows kinds are
 * SHELL_NOT_FOUND there, the Linux kinds on Windows. `availablePosixShells` lists what
 * `shell.detect` offers (`login` always, then the installed ones).
 */
import os from 'node:os';
import path from 'node:path';
import { makeError } from '@shared/errors';
import { POSIX_SHELL_KINDS, type ConsoleSettings, type ShellKind } from '@shared/model';
import { POSIX_PATHS, windowsPathIssue } from '@shared/paths';
import { envPathDelimiter, setEnvVar, stripNodeModulesBin } from '../claude/env';
import { powerShellPath } from '../lib/powershell';
import { guiEnvironment, systemTool } from '../lib/process';
import { expandRegValue, parseRegValues, type RegKeyQuery } from '../lib/registry';
import { getEnvVar, nodeFsProbe, resolveExecutable, type FsProbe } from '../lib/windows';
import { CommandError } from '../sync/ports';

/** The Git for Windows launcher of mintty (Start menu "Git Bash"). */
export const GIT_BASH_EXE = 'git-bash.exe';
/** The bash of Git for Windows for a console (sets MSYSTEM and PATH, then starts usr\bin\bash). */
export const GIT_BASH_CONSOLE = path.win32.join('bin', 'bash.exe');

const UNINSTALL_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1';
const HIVES = [
  ['HKCU', 64],
  ['HKLM', 64],
  ['HKLM', 32],
] as const;
/** Usual install folders: [environment variable, folder below it]. */
const STANDARD_PATHS = [
  ['ProgramFiles', 'Git'],
  ['LOCALAPPDATA', 'Programs\\Git'],
] as const;

export interface GitLocatorDeps {
  fs: FsProbe;
  env: Readonly<Record<string, string | undefined>>;
  regKeyQuery: RegKeyQuery;
}

/**
 * The environment of a started shell (see the file comment): `guiEnvironment` plus PATH without
 * `node_modules\.bin` entries. POSIX (WP-105): only `PATH` exactly, split at `:`.
 */
export function shellEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env = guiEnvironment(base, platform);
  const isPath = (name: string): boolean =>
    platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH';
  for (const [name, value] of Object.entries(env)) {
    if (isPath(name)) env[name] = stripNodeModulesBin(value, envPathDelimiter(platform)).value;
  }
  return env;
}

/** A folder of Git for Windows: safe, absolute, with `git-bash.exe` and `bin\bash.exe`. */
export async function isGitDir(folder: string, fs: FsProbe): Promise<boolean> {
  if (windowsPathIssue(folder) !== null || !path.win32.isAbsolute(folder)) return false;
  return (
    (await fs.isFile(path.win32.join(folder, GIT_BASH_EXE))) &&
    (await fs.isFile(path.win32.join(folder, GIT_BASH_CONSOLE)))
  );
}

/** Candidates in lookup order, produced lazily (no `reg.exe` after the first hit). */
async function* gitDirCandidates(deps: GitLocatorDeps): AsyncGenerator<string> {
  for (const [variable, folder] of STANDARD_PATHS) {
    const root = getEnvVar(deps.env, variable);
    if (root !== undefined && root !== '') yield path.win32.join(root, folder);
  }
  // Git for Windows: always the Windows lookup (PATH at `;`, PATHEXT), whatever platform runs the tests.
  const git = await resolveExecutable('git', deps.env, deps.fs, 'win32');
  if (git !== null) {
    // <Git>\cmd\git.exe, <Git>\bin\git.exe → <Git>; <Git>\mingw64\bin\git.exe → <Git>.
    const parent = path.win32.dirname(path.win32.dirname(git));
    yield parent;
    yield path.win32.dirname(parent);
  }
  for (const [hive, view] of HIVES) {
    const output = await deps.regKeyQuery(`${hive}\\${UNINSTALL_KEY}`, view);
    if (output === null) continue;
    const location = parseRegValues(output).find(
      (value) =>
        value.name.toLowerCase() === 'installlocation' &&
        (value.type === 'REG_SZ' || value.type === 'REG_EXPAND_SZ'),
    );
    if (location === undefined) continue;
    const raw = location.data.trim().replace(/^"(.*)"$/, '$1');
    const folder = location.type === 'REG_EXPAND_SZ' ? expandRegValue(raw, deps.env) : raw;
    if (folder !== '') yield folder.replace(/[\\/]+$/, '');
  }
}

/** The detected Git for Windows folder, or null. */
export async function findGitDir(deps: GitLocatorDeps): Promise<string | null> {
  for await (const candidate of gitDirCandidates(deps)) {
    if (await isGitDir(candidate, deps.fs)) return candidate;
  }
  return null;
}

/** How long a found Git folder is reused without a new lookup (like EDITOR_CACHE_MS). */
export const GIT_CACHE_MS = 60_000;

export interface GitFinder {
  /**
   * The folder from the settings if it is a Git folder, else the detected one (the last hit for
   * `ttlMs`, reused only while it still is a Git folder; a miss is never cached).
   */
  find(override: string | null, deps: GitLocatorDeps): Promise<string | null>;
  /** Like `find`, but always a fresh lookup (`shell.detect`); the result replaces the cached one. */
  refresh(override: string | null, deps: GitLocatorDeps): Promise<string | null>;
}

export function createGitFinder(options: { ttlMs?: number; now?: () => number } = {}): GitFinder {
  const ttlMs = options.ttlMs ?? GIT_CACHE_MS;
  const now = options.now ?? Date.now;
  let hit: { folder: string; at: number } | null = null;
  const detect = async (deps: GitLocatorDeps): Promise<string | null> => {
    const found = await findGitDir(deps);
    hit = found === null ? null : { folder: found, at: now() };
    return found;
  };
  return {
    async find(override, deps) {
      if (override !== null && (await isGitDir(override, deps.fs))) return override;
      if (hit !== null && now() - hit.at < ttlMs && (await isGitDir(hit.folder, deps.fs))) return hit.folder;
      return detect(deps);
    },
    async refresh(override, deps) {
      if (override !== null && (await isGitDir(override, deps.fs))) return override;
      return detect(deps);
    },
  };
}

/** Where a shell runs: a window of its own (WP-97) or the embedded terminal (WP-99). */
export type ShellMode = 'window' | 'embedded';

/** What to start for a shell (the working folder is the session's cwd, set by the caller). */
export interface ShellLaunch {
  /** Absolute program (`.exe` on Windows). */
  executablePath: string;
  args: string[];
  /** Complete environment of the shell. */
  env: Record<string, string>;
}

export interface ShellLaunchDeps {
  /** The Git for Windows folder (`GitFinder.find` with the settings' override), null = not installed. */
  gitDir: () => Promise<string | null>;
  /** Base environment (default `process.env`), made neutral by `shellEnvironment`. */
  env?: NodeJS.ProcessEnv;
  /** WP-105: the host's platform (default `process.platform`; tests pass both). */
  platform?: NodeJS.Platform;
  /** WP-105: file checks of the POSIX lookups (default `nodeFsProbe`). */
  fs?: FsProbe;
  /** WP-105: the shell of the user's passwd entry (default `userPasswdShell`); null = unknown. */
  passwdShell?: () => string | null;
}

/** `--cd=` argument of git-bash.exe: a folder ending in `\` (drive root) gets a `.` (see the file comment). */
export function gitBashCdArgument(cwd: string): string {
  return `--cd=${/[\\/]$/.test(cwd) ? `${cwd}.` : cwd}`;
}

function shellNotFound(kind: ShellKind): CommandError {
  return new CommandError(makeError('SHELL_NOT_FOUND', { shell: kind }));
}

/** The shells looked up on PATH of a POSIX host (display order of `POSIX_SHELL_KINDS`, without `login`). */
const POSIX_PATH_SHELLS = POSIX_SHELL_KINDS.filter((kind) => kind !== 'login');

/** Fallbacks of the login shell when neither `$SHELL` nor the passwd entry names a usable one. */
export const POSIX_FALLBACK_SHELLS = ['/bin/bash', '/bin/sh'] as const;

/** Shells of accounts that may not log in (`/usr/sbin/nologin`, `/bin/false`) – never started. */
const NO_LOGIN_SHELLS: ReadonlySet<string> = new Set(['nologin', 'false', 'true']);

/** The shell of this user's passwd entry (`os.userInfo()`); null if unknown. */
export function userPasswdShell(): string | null {
  try {
    const shell = os.userInfo().shell;
    return shell === null || shell === '' ? null : shell;
  } catch {
    return null;
  }
}

/** A login-shell candidate: absolute and safe (its real path too), executable, not a no-login shell. */
async function usableShell(file: string, fs: FsProbe): Promise<boolean> {
  if (POSIX_PATHS.issue(file) !== null || NO_LOGIN_SHELLS.has(path.posix.basename(file))) return false;
  const executable = fs.isExecutable === undefined ? await fs.isFile(file) : await fs.isExecutable(file);
  if (!executable) return false;
  const real = fs.realpath === undefined ? file : await fs.realpath(file);
  return real !== null && POSIX_PATHS.issue(real) === null;
}

/** The user's login shell (see the file comment); null if none of the candidates is usable. */
export async function findLoginShell(
  env: Readonly<Record<string, string | undefined>>,
  fs: FsProbe,
  passwdShell: () => string | null = userPasswdShell,
): Promise<string | null> {
  const candidates = [getEnvVar(env, 'SHELL', 'linux'), passwdShell(), ...POSIX_FALLBACK_SHELLS];
  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      candidate !== null &&
      candidate !== '' &&
      (await usableShell(candidate, fs))
    )
      return candidate;
  }
  return null;
}

/** Arguments that start `program` as a login shell (by its base name; see the file comment). */
export function posixLoginArgs(program: string): string[] {
  const name = path.posix.basename(program);
  if (name === 'fish') return ['--login'];
  // PowerShell wants `-Login` as its first parameter.
  if (name === 'pwsh' || name.startsWith('pwsh-')) return ['-Login', '-NoLogo'];
  return ['-l'];
}

/** The shells `shell.detect` offers on a POSIX host: `login` always, then the installed ones. */
export async function availablePosixShells(
  env: Readonly<Record<string, string | undefined>>,
  fs: FsProbe = nodeFsProbe,
): Promise<ShellKind[]> {
  const shells: ShellKind[] = ['login'];
  for (const kind of POSIX_PATH_SHELLS) {
    if ((await resolveExecutable(kind, env, fs, 'linux')) !== null) shells.push(kind);
  }
  return shells;
}

async function resolvePosixShellLaunch(
  kind: ShellKind,
  env: Record<string, string>,
  deps: ShellLaunchDeps,
): Promise<ShellLaunch> {
  const fs = deps.fs ?? nodeFsProbe;
  let program: string | null = null;
  switch (kind) {
    case 'login':
      program = await findLoginShell(env, fs, deps.passwdShell);
      break;
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'pwsh':
      // Looked up in the PATH the shell itself gets (without `node_modules/.bin`).
      program = await resolveExecutable(kind, env, fs, 'linux');
      break;
    case 'cmd':
    case 'powershell':
    case 'gitbash':
      // Windows shells exist only on a Windows host.
      break;
  }
  if (program === null) throw shellNotFound(kind);
  return { executablePath: program, args: posixLoginArgs(program), env };
}

/**
 * The launch of `kind` in `cwd`. Throws CommandError SHELL_NOT_FOUND {shell} when Git for Windows
 * is missing (cmd and PowerShell are part of Windows), a Linux shell is not installed, or the kind
 * belongs to the other platform (WP-105).
 */
export async function resolveShellLaunch(
  kind: ShellKind,
  cwd: string,
  settings: ConsoleSettings,
  mode: ShellMode,
  deps: ShellLaunchDeps,
): Promise<ShellLaunch> {
  const base = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const env = shellEnvironment(base, platform);
  if (platform !== 'win32') return resolvePosixShellLaunch(kind, env, deps);
  switch (kind) {
    case 'cmd':
      return { executablePath: systemTool('cmd.exe', base, platform), args: [], env };
    case 'powershell':
      return { executablePath: powerShellPath(base), args: ['-NoLogo'], env };
    case 'gitbash': {
      const gitDir = await deps.gitDir();
      if (gitDir === null) throw shellNotFound(kind);
      if (mode === 'window' && settings.gitBashWindow === 'mintty') {
        return {
          executablePath: path.win32.join(gitDir, GIT_BASH_EXE),
          args: [gitBashCdArgument(cwd)],
          env,
        };
      }
      setEnvVar(env, 'CHERE_INVOKING', '1', platform);
      return {
        executablePath: path.win32.join(gitDir, GIT_BASH_CONSOLE),
        args: ['--login', '-i'],
        env,
      };
    }
    // The Linux shells exist only on a Linux host (WP-105).
    case 'login':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'pwsh':
      throw shellNotFound(kind);
  }
}
