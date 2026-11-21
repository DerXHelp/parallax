import { existsSync } from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONSOLE_SETTINGS, POSIX_SHELL_KINDS, type ConsoleSettings } from '@shared/model';
import { POSIX_PATHS } from '@shared/paths';
import { powerShellPath } from '../lib/powershell';
import { runFile, systemTool } from '../lib/process';
import type { RegView } from '../lib/registry';
import { createMemoryFs } from '../lib/windows';
import { CommandError } from '../sync/ports';
import {
  NO_CWD_EXE_SEARCH,
  POWERSHELL_LINE_CHECK,
  POWERSHELL_STOP_ON_ERROR,
  availablePosixShells,
  createGitFinder,
  findGitDir,
  findLoginShell,
  gitBashCdArgument,
  isGitDir,
  posixLoginArgs,
  powerShellScript,
  resolveShellLaunch,
  scriptLaunch,
  shellEnvironment,
  type GitLocatorDeps,
  type ScriptLaunch,
} from './shells';

describe('scriptLaunch (WP-111, ADR-251)', () => {
  const env = { PATH: 'x' };
  /** SR3: every Windows project command runs without the program search in the current folder. */
  const winEnv = { PATH: 'x', [NO_CWD_EXE_SEARCH]: '1' };
  const check = POWERSHELL_LINE_CHECK;

  it('cmd: verbatim command line, quotes inside unchanged, lines joined with && (stops at the first failure)', () => {
    const launch = { executablePath: 'C:\\Windows\\System32\\cmd.exe', args: [], env };
    expect(scriptLaunch(launch, 'cmd', 'copy "a b.txt" c.txt\r\n\r\nnpm install', 'win32')).toEqual({
      executablePath: launch.executablePath,
      args: ['/d', '/s', '/c', 'copy "a b.txt" c.txt && npm install'],
      env: winEnv,
      windowsCommandLine: '"C:\\Windows\\System32\\cmd.exe" /d /s /c "copy "a b.txt" c.txt && npm install"',
    });
    // The launch of the caller stays untouched.
    expect(launch.env).toEqual({ PATH: 'x' });
  });

  it('CR6: PowerShell stops at the first failing line (Stop + a check after every line)', () => {
    const ps = { executablePath: 'C:\\ps\\powershell.exe', args: ['-NoLogo'], env };
    const result = scriptLaunch(ps, 'powershell', 'npm i; echo "ok"\r\n\r\n  npm test  ', 'win32');
    expect(result.args).toEqual([
      '-NoLogo',
      '-Command',
      [POWERSHELL_STOP_ON_ERROR, 'npm i; echo "ok"', check, 'npm test', check].join('\n'),
    ]);
    expect(result.env).toEqual(winEnv);
    expect(powerShellScript('a')).toBe(`$ErrorActionPreference = 'Stop'\na\n${check}`);
  });

  it('CR6: Git Bash and POSIX sh-like shells get `set -e` after the login profile', () => {
    const bash = { executablePath: 'C:\\Git\\bin\\bash.exe', args: ['--login', '-i'], env };
    const result = scriptLaunch(bash, 'gitbash', 'pnpm i\nmake', 'win32');
    expect(result.args).toEqual(['--login', '-c', 'set -e\npnpm i\nmake']);
    expect(result.env).toEqual(winEnv);
    expect(result.windowsCommandLine).toBeUndefined();
  });

  it('POSIX: login arguments, then -c (fish: `or exit $status` per line; pwsh -Command with checks)', () => {
    expect(
      scriptLaunch({ executablePath: '/bin/bash', args: ['-l'], env }, 'login', 'make\nmake test', 'linux'),
    ).toEqual({ executablePath: '/bin/bash', args: ['-l', '-c', 'set -e\nmake\nmake test'], env });
    expect(
      scriptLaunch({ executablePath: '/usr/bin/zsh', args: [], env }, 'zsh', 'make', 'linux').args,
    ).toEqual(['-l', '-c', 'set -e\nmake']);
    expect(
      scriptLaunch({ executablePath: '/usr/bin/fish', args: [], env }, 'fish', 'make\nmake test', 'linux')
        .args,
    ).toEqual(['--login', '-c', 'make\nor exit $status\nmake test\nor exit $status']);
    expect(
      scriptLaunch({ executablePath: '/usr/bin/pwsh', args: [], env }, 'pwsh', 'make', 'linux').args,
    ).toEqual(['-Login', '-NoLogo', '-Command', `${POWERSHELL_STOP_ON_ERROR}\nmake\n${check}`]);
  });

  describe.runIf(process.platform === 'win32')(
    'CR6: the real Windows shells end with the first failure',
    () => {
      const run = async (launch: ScriptLaunch) =>
        runFile(launch.executablePath, launch.args, { env: launch.env, timeoutMs: 60_000, cwd: os.tmpdir() });

      it('cmd', { timeout: 60_000 }, async () => {
        const launch = scriptLaunch(
          { executablePath: systemTool('cmd.exe'), args: [], env: shellEnvironment() },
          'cmd',
          'cmd /d /c exit 3\necho second',
          'win32',
        );
        const result = await run(launch);
        expect(result.exitCode).toBe(3);
        expect(result.stdout).not.toContain('second');
      });

      it(
        'PowerShell: a failing program (its exit code) and a failing cmdlet (1)',
        { timeout: 60_000 },
        async () => {
          const shell = { executablePath: powerShellPath(), args: [], env: shellEnvironment() };
          const program = await run(
            scriptLaunch(shell, 'powershell', 'cmd /d /c exit 3\necho second', 'win32'),
          );
          expect(program.exitCode).toBe(3);
          expect(program.stdout).not.toContain('second');
          const cmdlet = await run(
            scriptLaunch(shell, 'powershell', 'Get-Item -LiteralPath C:\\px-missing-x\necho second', 'win32'),
          );
          expect(cmdlet.exitCode).toBe(1);
          expect(cmdlet.stdout).not.toContain('second');
          const fine = await run(scriptLaunch(shell, 'powershell', 'cmd /d /c exit 0\necho second', 'win32'));
          expect(fine.exitCode).toBe(0);
          expect(fine.stdout).toContain('second');
        },
      );

      const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
      it.runIf(existsSync(gitBash))('Git Bash', { timeout: 60_000 }, async () => {
        const shell = { executablePath: gitBash, args: [], env: shellEnvironment() };
        const result = await run(scriptLaunch(shell, 'gitbash', 'false\necho second', 'win32'));
        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toContain('second');
      });
    },
  );
});

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
    const env = shellEnvironment(
      {
        Path: 'D:\\work\\proj\\node_modules\\.bin;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        PARALLAX: '1',
        PARALLAX_ENTRY_ID: 'en_x',
        npm_lifecycle_event: 'start',
        CLAUDE_CONFIG_DIR: 'C:\\Users\\jane\\.claude-work',
        USERPROFILE: 'C:\\Users\\jane',
        NODE_OPTIONS: '--max-old-space-size=4096',
      },
      'win32',
    );
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
    const env = shellEnvironment({ Path: 'C:\\Windows' }, 'win32');
    expect(Object.keys(env)).toEqual(['Path']);
  });

  it('POSIX (WP-105): only PATH exactly, split at a colon', () => {
    const env = shellEnvironment(
      {
        PATH: '/home/demo/proj/node_modules/.bin:/usr/local/bin:/usr/bin',
        Path: '/home/demo/proj/node_modules/.bin',
        PARALLAX_ENTRY_ID: 'en_x',
        CLAUDECODE: '1',
        HOME: '/home/demo',
      },
      'linux',
    );
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
    // Another spelling is another variable on POSIX – left alone.
    expect(env.Path).toBe('/home/demo/proj/node_modules/.bin');
    expect(env.HOME).toBe('/home/demo');
    expect(env).not.toHaveProperty('PARALLAX_ENTRY_ID');
    expect(env).not.toHaveProperty('CLAUDECODE');
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
  const windows = { env: ENV, platform: 'win32' } as const;

  it('cmd and PowerShell from the Windows folder, never through PATH', async () => {
    const cmd = await resolveShellLaunch('cmd', 'D:\\work', settings(), 'window', {
      ...windows,
      gitDir: noGit,
    });
    expect(cmd).toMatchObject({ executablePath: 'C:\\Windows\\System32\\cmd.exe', args: [] });
    const ps = await resolveShellLaunch('powershell', 'D:\\work', settings(), 'window', {
      ...windows,
      gitDir: noGit,
    });
    expect(ps).toMatchObject({
      executablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoLogo'],
    });
  });

  it('Git Bash as mintty: git-bash.exe with --cd (a drive root gets a dot)', async () => {
    const launch = await resolveShellLaunch('gitbash', 'D:\\Mein Ordner\\ä', settings(), 'window', {
      ...windows,
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
        ...windows,
        gitDir: withGit,
      },
    );
    expect(terminal).toMatchObject({ executablePath: `${GIT}\\bin\\bash.exe`, args: ['--login', '-i'] });
    expect(terminal.env.CHERE_INVOKING).toBe('1');
    const embedded = await resolveShellLaunch('gitbash', 'D:\\work', settings(), 'embedded', {
      ...windows,
      gitDir: withGit,
    });
    expect(embedded.executablePath).toBe(`${GIT}\\bin\\bash.exe`);
  });

  it('SHELL_NOT_FOUND without Git for Windows', async () => {
    expect(
      await errorPayload(
        resolveShellLaunch('gitbash', 'D:\\work', settings(), 'window', { ...windows, gitDir: noGit }),
      ),
    ).toEqual({ code: 'SHELL_NOT_FOUND', params: { shell: 'gitbash' } });
  });

  it('the Linux shells are SHELL_NOT_FOUND on Windows (WP-105)', async () => {
    for (const kind of POSIX_SHELL_KINDS) {
      expect(
        await errorPayload(
          resolveShellLaunch(kind, 'D:\\work', settings(), 'embedded', { ...windows, gitDir: withGit }),
        ),
      ).toEqual({ code: 'SHELL_NOT_FOUND', params: { shell: kind } });
    }
  });
});

// ---- Linux (WP-105) – through the seams, so it runs on every platform ----

const HOME_ENV = {
  HOME: '/home/demo',
  PATH: '/home/demo/proj/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
  SHELL: '/usr/bin/zsh',
  PARALLAX_ENTRY_ID: 'en_parent',
  CLAUDECODE: '1',
};

/** A POSIX memory file system (exact case); `links` = realpath answers. */
function posixFs(
  files: readonly string[],
  options: { notExecutable?: string[]; links?: Record<string, string> } = {},
) {
  return createMemoryFs(Object.fromEntries(files.map((file) => [file, ''])), {
    rules: POSIX_PATHS,
    ...options,
  });
}

describe('findLoginShell (WP-105)', () => {
  it('$SHELL first, then the passwd entry, then /bin/bash and /bin/sh', async () => {
    const all = posixFs(['/usr/bin/zsh', '/usr/bin/fish', '/bin/bash', '/bin/sh']);
    expect(await findLoginShell(HOME_ENV, all, () => '/usr/bin/fish')).toBe('/usr/bin/zsh');
    expect(await findLoginShell({ ...HOME_ENV, SHELL: '' }, all, () => '/usr/bin/fish')).toBe(
      '/usr/bin/fish',
    );
    expect(await findLoginShell({}, all, () => null)).toBe('/bin/bash');
    expect(await findLoginShell({}, posixFs(['/bin/sh']), () => null)).toBe('/bin/sh');
    expect(await findLoginShell({}, posixFs([]), () => null)).toBeNull();
  });

  it('skips relative, unsafe, missing, non-executable and no-login shells', async () => {
    const fs = posixFs(['/bin/bash', '/usr/bin/zsh', '/usr/sbin/nologin', '/opt/sh/link'], {
      notExecutable: ['/usr/bin/zsh'],
      links: { '/opt/sh/link': '/proc/self/exe' },
    });
    for (const shell of ['zsh', '/usr/bin/../bin/zsh', '/usr/bin/zsh', '/usr/sbin/nologin', '/opt/sh/link']) {
      expect(await findLoginShell({ SHELL: shell }, fs, () => null)).toBe('/bin/bash');
    }
    expect(await findLoginShell({ SHELL: '/usr/bin/fish' }, fs, () => '/bin/false')).toBe('/bin/bash');
    // `$SHELL` is exact on POSIX: `shell` is another variable.
    expect(
      await findLoginShell({ shell: '/usr/bin/zsh' }, posixFs(['/usr/bin/zsh', '/bin/bash']), () => null),
    ).toBe('/bin/bash');
  });
});

describe('posixLoginArgs (WP-105)', () => {
  it('-l for sh-like shells, --login for fish, -Login -NoLogo for pwsh', () => {
    expect(posixLoginArgs('/usr/bin/bash')).toEqual(['-l']);
    expect(posixLoginArgs('/usr/bin/zsh')).toEqual(['-l']);
    expect(posixLoginArgs('/bin/sh')).toEqual(['-l']);
    expect(posixLoginArgs('/usr/bin/fish')).toEqual(['--login']);
    expect(posixLoginArgs('/opt/microsoft/powershell/7/pwsh')).toEqual(['-Login', '-NoLogo']);
    expect(posixLoginArgs('/snap/bin/pwsh-preview')).toEqual(['-Login', '-NoLogo']);
  });
});

describe('resolveShellLaunch on Linux (WP-105)', () => {
  const linux = (fs: ReturnType<typeof posixFs>, passwd: string | null = null) =>
    ({
      env: HOME_ENV,
      platform: 'linux',
      fs,
      passwdShell: () => passwd,
      gitDir: () => Promise.reject(new Error('no Git lookup on Linux')),
    }) as const;

  it('login: the login shell as a login shell, neutral environment, the same in the window', async () => {
    const fs = posixFs(['/usr/bin/zsh', '/bin/bash']);
    const embedded = await resolveShellLaunch('login', '/home/demo/proj', settings(), 'embedded', linux(fs));
    expect(embedded).toMatchObject({ executablePath: '/usr/bin/zsh', args: ['-l'] });
    expect(embedded.env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(embedded.env).not.toHaveProperty('PARALLAX_ENTRY_ID');
    expect(embedded.env).not.toHaveProperty('CLAUDECODE');
    // The pty adds TERM itself; the window's terminal emulator sets its own.
    expect(embedded.env).not.toHaveProperty('TERM');
    const window = await resolveShellLaunch('login', '/home/demo/proj', settings(), 'window', linux(fs));
    expect(window).toMatchObject({ executablePath: '/usr/bin/zsh', args: ['-l'] });
  });

  it('bash, zsh, fish and pwsh from the PATH of the shell (never node_modules/.bin, never the cwd)', async () => {
    const fs = posixFs([
      '/home/demo/proj/node_modules/.bin/bash',
      '/usr/bin/bash',
      '/usr/bin/zsh',
      '/usr/local/bin/fish',
      '/usr/bin/pwsh',
    ]);
    const launch = (kind: 'bash' | 'zsh' | 'fish' | 'pwsh') =>
      resolveShellLaunch(kind, '/home/demo/proj', settings(), 'embedded', linux(fs));
    expect(await launch('bash')).toMatchObject({ executablePath: '/usr/bin/bash', args: ['-l'] });
    expect(await launch('zsh')).toMatchObject({ executablePath: '/usr/bin/zsh', args: ['-l'] });
    expect(await launch('fish')).toMatchObject({ executablePath: '/usr/local/bin/fish', args: ['--login'] });
    expect(await launch('pwsh')).toMatchObject({
      executablePath: '/usr/bin/pwsh',
      args: ['-Login', '-NoLogo'],
    });
  });

  it('SHELL_NOT_FOUND for a missing shell and for the Windows kinds', async () => {
    const fs = posixFs(['/usr/bin/bash']);
    for (const kind of ['zsh', 'cmd', 'powershell', 'gitbash'] as const) {
      expect(
        await errorPayload(resolveShellLaunch(kind, '/home/demo/proj', settings(), 'embedded', linux(fs))),
      ).toEqual({ code: 'SHELL_NOT_FOUND', params: { shell: kind } });
    }
    expect(
      await errorPayload(
        resolveShellLaunch('login', '/home/demo', settings(), 'embedded', linux(posixFs([]))),
      ),
    ).toEqual({ code: 'SHELL_NOT_FOUND', params: { shell: 'login' } });
  });
});

describe('availablePosixShells (WP-105)', () => {
  it('login always, then the installed shells in display order', async () => {
    expect(await availablePosixShells({ PATH: '/usr/bin' }, posixFs([]))).toEqual(['login']);
    const fs = posixFs(['/usr/bin/pwsh', '/usr/bin/bash', '/usr/local/bin/fish']);
    expect(await availablePosixShells({ PATH: '/usr/local/bin:/usr/bin' }, fs)).toEqual([
      'login',
      'bash',
      'fish',
      'pwsh',
    ]);
  });
});
