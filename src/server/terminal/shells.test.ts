import { describe, expect, it } from 'vitest';
import { DEFAULT_CONSOLE_SETTINGS, type ConsoleSettings } from '@shared/model';
import type { RegView } from '../lib/registry';
import { createMemoryFs } from '../lib/windows';
import { CommandError } from '../sync/ports';
import {
  createGitFinder,
  findGitDir,
  gitBashCdArgument,
  isGitDir,
  resolveShellLaunch,
  shellEnvironment,
  type GitLocatorDeps,
} from './shells';

const GIT = 'C:\\Program Files\\Git';
const USER_GIT = 'C:\\Users\\jane\\AppData\\Local\\Programs\\Git';
const ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\jane\\AppData\\Local',
  PATHEXT: '.EXE',
};

/** The two files that make a Git for Windows folder. */
function gitFiles(folder: string): Record<string, string> {
  return { [`${folder}\\git-bash.exe`]: '', [`${folder}\\bin\\bash.exe`]: '' };
}

const installLocation = (value: string) =>
  `\r\nHKEY\\x\r\n    DisplayName    REG_SZ    Git\r\n    InstallLocation    REG_SZ    ${value}\r\n`;

/** Registry fake: `<key>@<view>` → output; `asked` lists every query. */
function deps(
  files: Record<string, string>,
  keys: Record<string, string> = {},
  env: Record<string, string> = ENV,
): GitLocatorDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    fs: createMemoryFs(files),
    env,
    asked,
    regKeyQuery: (key: string, view: RegView) => {
      asked.push(`${key}@${String(view)}`);
      return Promise.resolve(keys[`${key}@${String(view)}`] ?? null);
    },
  };
}

const settings = (p: Partial<ConsoleSettings> = {}): ConsoleSettings => ({
  ...DEFAULT_CONSOLE_SETTINGS,
  ...p,
});

async function errorPayload(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.catch((caught: unknown) => caught);
  return error instanceof CommandError ? error.error : error;
}

describe('shellEnvironment (ADR-238: neutral)', () => {
  it('drops Claude session, Parallax and pnpm run variables and node_modules\\.bin, keeps the rest', () => {
    const env = shellEnvironment({
      Path: 'D:\\work\\proj\\node_modules\\.bin;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      PARALLAX: '1',
      PARALLAX_ENTRY_ID: 'en_x',
      npm_lifecycle_event: 'start',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\jane\\.claude-work',
      USERPROFILE: 'C:\\Users\\jane',
      NODE_OPTIONS: '--max-old-space-size=4096',
    });
    expect(env.Path).toBe('C:\\Windows\\System32;C:\\Program Files\\Git\\cmd');
    expect(env.USERPROFILE).toBe('C:\\Users\\jane');
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    for (const name of [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'PARALLAX',
      'PARALLAX_ENTRY_ID',
      'npm_lifecycle_event',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it('never adds a profile: only what the base has (no CLAUDE_CONFIG_DIR of its own)', () => {
    const env = shellEnvironment({ Path: 'C:\\Windows' });
    expect(Object.keys(env)).toEqual(['Path']);
  });
});

describe('findGitDir (ADR-238)', () => {
  it('the standard folder first, without asking the registry', async () => {
    const d = deps(gitFiles(GIT));
    expect(await findGitDir(d)).toBe(GIT);
    expect(d.asked).toEqual([]);
  });

  it('the per-user install below LOCALAPPDATA', async () => {
    expect(await findGitDir(deps(gitFiles(USER_GIT)))).toBe(USER_GIT);
  });

  it('the folder of git.exe on PATH (cmd\\git.exe or mingw64\\bin\\git.exe)', async () => {
    const env = {
      ...ENV,
      ProgramFiles: 'C:\\nowhere',
      LOCALAPPDATA: 'C:\\nowhere',
      PATH: 'D:\\Tools\\Git\\cmd',
    };
    const files = { 'D:\\Tools\\Git\\cmd\\git.exe': '', ...gitFiles('D:\\Tools\\Git') };
    expect(await findGitDir(deps(files, {}, env))).toBe('D:\\Tools\\Git');
    const deep = { ...env, PATH: 'D:\\Tools\\Git\\mingw64\\bin' };
    const deepFiles = { 'D:\\Tools\\Git\\mingw64\\bin\\git.exe': '', ...gitFiles('D:\\Tools\\Git') };
    expect(await findGitDir(deps(deepFiles, {}, deep))).toBe('D:\\Tools\\Git');
  });

  it('last: InstallLocation of the uninstall key (trailing backslash dropped)', async () => {
    const env = { ...ENV, ProgramFiles: 'C:\\nowhere', LOCALAPPDATA: 'C:\\nowhere' };
    const key = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1@64';
    const d = deps(gitFiles('E:\\Git'), { [key]: installLocation('E:\\Git\\') }, env);
    expect(await findGitDir(d)).toBe('E:\\Git');
    expect(d.asked[0]).toContain('HKCU');
  });

  it('null without git-bash.exe and bin\\bash.exe; unsafe folders are never touched', async () => {
    expect(await findGitDir(deps({ [`${GIT}\\git-bash.exe`]: '' }))).toBeNull();
    const fs = createMemoryFs({});
    expect(await isGitDir('\\\\server\\share\\Git', fs)).toBe(false);
    expect(await isGitDir('relative\\Git', fs)).toBe(false);
    expect(fs.touched).toEqual([]);
  });
});

describe('createGitFinder', () => {
  it('an existing override wins; a missing one falls back to the lookup', async () => {
    const finder = createGitFinder();
    expect(
      await finder.find('D:\\PortableGit', deps({ ...gitFiles(GIT), ...gitFiles('D:\\PortableGit') })),
    ).toBe('D:\\PortableGit');
    expect(await finder.find('D:\\PortableGit', deps(gitFiles(GIT)))).toBe(GIT);
  });

  it('reuses a hit for the TTL while it still exists; refresh always looks again', async () => {
    let now = 0;
    const finder = createGitFinder({ ttlMs: 1000, now: () => now });
    expect(await finder.find(null, deps(gitFiles(GIT)))).toBe(GIT);
    // The standard folder is gone but the hit is still a Git folder in this file system.
    const moved = deps(
      { ...gitFiles(GIT), ...gitFiles(USER_GIT) },
      {},
      { ...ENV, ProgramFiles: 'C:\\nowhere' },
    );
    expect(await finder.find(null, moved)).toBe(GIT);
    expect(await finder.refresh(null, moved)).toBe(USER_GIT);
    now = 2000;
    expect(await finder.find(null, deps({}))).toBeNull();
  });
});

describe('resolveShellLaunch (WP-97)', () => {
  const noGit = () => Promise.resolve(null);
  const withGit = () => Promise.resolve(GIT);

  it('cmd and PowerShell from the Windows folder, never through PATH', async () => {
    const cmd = await resolveShellLaunch('cmd', 'D:\\work', settings(), 'window', {
      env: ENV,
      gitDir: noGit,
    });
    expect(cmd).toMatchObject({ executablePath: 'C:\\Windows\\System32\\cmd.exe', args: [] });
    const ps = await resolveShellLaunch('powershell', 'D:\\work', settings(), 'window', {
      env: ENV,
      gitDir: noGit,
    });
    expect(ps).toMatchObject({
      executablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoLogo'],
    });
  });

  it('Git Bash as mintty: git-bash.exe with --cd (a drive root gets a dot)', async () => {
    const launch = await resolveShellLaunch('gitbash', 'D:\\Mein Ordner\\ä', settings(), 'window', {
      env: ENV,
      gitDir: withGit,
    });
    expect(launch).toMatchObject({
      executablePath: `${GIT}\\git-bash.exe`,
      args: ['--cd=D:\\Mein Ordner\\ä'],
    });
    expect(launch.env).not.toHaveProperty('CHERE_INVOKING');
    expect(gitBashCdArgument('D:\\')).toBe('--cd=D:\\.');
  });

  it('Git Bash in the default terminal and embedded: bin\\bash.exe --login -i with CHERE_INVOKING', async () => {
    const terminal = await resolveShellLaunch(
      'gitbash',
      'D:\\work',
      settings({ gitBashWindow: 'terminal' }),
      'window',
      {
        env: ENV,
        gitDir: withGit,
      },
    );
    expect(terminal).toMatchObject({ executablePath: `${GIT}\\bin\\bash.exe`, args: ['--login', '-i'] });
    expect(terminal.env.CHERE_INVOKING).toBe('1');
    const embedded = await resolveShellLaunch('gitbash', 'D:\\work', settings(), 'embedded', {
      env: ENV,
      gitDir: withGit,
    });
    expect(embedded.executablePath).toBe(`${GIT}\\bin\\bash.exe`);
  });

  it('SHELL_NOT_FOUND without Git for Windows', async () => {
    expect(
      await errorPayload(
        resolveShellLaunch('gitbash', 'D:\\work', settings(), 'window', { env: ENV, gitDir: noGit }),
      ),
    ).toEqual({ code: 'SHELL_NOT_FOUND', params: { shell: 'gitbash' } });
  });
});
