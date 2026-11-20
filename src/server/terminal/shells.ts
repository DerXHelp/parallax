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
 */
import path from 'node:path';
import { makeError } from '@shared/errors';
import type { ConsoleSettings, ShellKind } from '@shared/model';
import { windowsPathIssue } from '@shared/paths';
import { setEnvVar, stripNodeModulesBin } from '../claude/env';
import { powerShellPath } from '../lib/powershell';
import { guiEnvironment, systemTool } from '../lib/process';
import { expandRegValue, parseRegValues, type RegKeyQuery } from '../lib/registry';
import { getEnvVar, resolveExecutable, type FsProbe } from '../lib/windows';
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
 * `node_modules\.bin` entries.
 */
export function shellEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = guiEnvironment(base);
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === 'PATH') env[name] = stripNodeModulesBin(value, path.win32.delimiter).value;
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
  const git = await resolveExecutable('git', deps.env, deps.fs);
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
  /** Absolute `.exe`. */
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
}

/** `--cd=` argument of git-bash.exe: a folder ending in `\` (drive root) gets a `.` (see the file comment). */
export function gitBashCdArgument(cwd: string): string {
  return `--cd=${/[\\/]$/.test(cwd) ? `${cwd}.` : cwd}`;
}

/**
 * The launch of `kind` in `cwd`. Throws CommandError SHELL_NOT_FOUND {shell} when Git for Windows
 * is missing (cmd and PowerShell are part of Windows).
 */
export async function resolveShellLaunch(
  kind: ShellKind,
  cwd: string,
  settings: ConsoleSettings,
  mode: ShellMode,
  deps: ShellLaunchDeps,
): Promise<ShellLaunch> {
  const base = deps.env ?? process.env;
  const env = shellEnvironment(base);
  switch (kind) {
    case 'cmd':
      return { executablePath: systemTool('cmd.exe', base), args: [], env };
    case 'powershell':
      return { executablePath: powerShellPath(base), args: ['-NoLogo'], env };
    case 'gitbash': {
      const gitDir = await deps.gitDir();
      if (gitDir === null) throw new CommandError(makeError('SHELL_NOT_FOUND', { shell: kind }));
      if (mode === 'window' && settings.gitBashWindow === 'mintty') {
        return {
          executablePath: path.win32.join(gitDir, GIT_BASH_EXE),
          args: [gitBashCdArgument(cwd)],
          env,
        };
      }
      setEnvVar(env, 'CHERE_INVOKING', '1');
      return {
        executablePath: path.win32.join(gitDir, GIT_BASH_CONSOLE),
        args: ['--login', '-i'],
        env,
      };
    }
  }
}
