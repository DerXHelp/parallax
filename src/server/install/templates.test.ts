import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runFile } from '../lib/process';
import { CURRENT_FILE, START_SCRIPT, START_SH } from './layout';
import {
  INSTALLER_FLAGS,
  commandScript,
  commandScriptRoot,
  installCmd,
  installSh,
  shellQuote,
  startCmd,
  startScript,
  startShell,
} from './templates';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A root with start.mjs, current.json and a version whose launcher/installer record their argv. */
async function root(options: { minNode?: string; current?: string } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp86-start-'));
  temps.push(dir);
  await writeFile(path.join(dir, START_SCRIPT), startScript());
  await writeFile(
    path.join(dir, CURRENT_FILE),
    options.current ?? JSON.stringify({ schemaVersion: 1, version: '1.2.0', previous: null }),
  );
  const version = path.join(dir, 'versions', '1.2.0');
  await mkdir(path.join(version, 'dist'), { recursive: true });
  await writeFile(
    path.join(version, 'release.json'),
    JSON.stringify({ minNode: options.minNode ?? '20.0.0' }),
  );
  for (const name of ['launcher', 'install']) {
    await writeFile(
      path.join(version, 'dist', `${name}.js`),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(path.join(dir, 'ran.json'))}, JSON.stringify({ entry: '${name}', argv: process.argv.slice(2), cwd: process.cwd() }));`,
      ].join('\n'),
    );
  }
  return dir;
}

async function start(dir: string, args: string[]) {
  const result = await runFile(process.execPath, [path.join(dir, START_SCRIPT), ...args], {
    cwd: os.tmpdir(),
    timeoutMs: 20_000,
  });
  let ran: { entry: string; argv: string[] } | null = null;
  try {
    ran = JSON.parse(await readFile(path.join(dir, 'ran.json'), 'utf8')) as { entry: string; argv: string[] };
  } catch {
    ran = null;
  }
  return { ...result, ran };
}

describe('start.mjs (WP-86, WP-83 §8.1)', () => {
  it('runs the launcher of the current version with --install-root in front', async () => {
    const dir = await root();
    const result = await start(dir, ['--autostart']);
    expect(result.exitCode).toBe(0);
    expect(result.ran).toEqual(
      expect.objectContaining({ entry: 'launcher', argv: [`--install-root=${dir}`, '--autostart'] }),
    );
  });

  it('hands --install, --uninstall and --use to the installer of the current version', async () => {
    for (const flag of INSTALLER_FLAGS) {
      const dir = await root();
      const args = flag === '--uninstall' ? [flag] : [`${flag}=x`];
      expect((await start(dir, args)).ran).toEqual(
        expect.objectContaining({ entry: 'install', argv: [`--install-root=${dir}`, ...args] }),
      );
    }
  });

  it('stops with a message for a missing or broken current.json and a too old Node', async () => {
    const broken = await root({ current: '{' });
    const first = await start(broken, []);
    expect(first.exitCode).toBe(1);
    expect(first.stderr).toMatch(/current\.json could not be read .*Install Parallax again/);
    expect(first.ran).toBeNull();

    const invalid = await root({ current: JSON.stringify({ version: '../../evil' }) });
    expect((await start(invalid, [])).stderr).toMatch(/names no valid version/);

    const old = await root({ minNode: '99.0.0' });
    const tooOld = await start(old, []);
    expect(tooOld.exitCode).toBe(1);
    expect(tooOld.stderr).toMatch(/Parallax 1\.2\.0 needs Node\.js 99\.0\.0 or newer/);
  });
});

describe('cmd files', () => {
  it('use CRLF, never the current directory, and the right entry', () => {
    for (const text of [startCmd('26.9.0'), installCmd('26.9.0')]) {
      expect(text.split('\r\n').length).toBeGreaterThan(10);
      expect(text.replace(/\r\n/g, '')).not.toContain('\n');
      expect(text).toContain('set "NoDefaultCurrentDirectoryInExePath=1"');
      expect(text).toContain('Node.js 26.9.0');
    }
    expect(startCmd('26.9.0')).toContain('node --use-system-ca --use-env-proxy "%~dp0start.mjs" %*');
    // install.cmd passes no Node flags: install.js adds them after its version check.
    expect(installCmd('26.9.0')).toContain('node "%~dp0dist\\install.js" %*');
  });
});

describe('names shared with the system integration', () => {
  it('system/markers.ts names the same start script and icon as the layout', async () => {
    const markers = await import('../system/markers');
    const layout = await import('./layout');
    expect(markers.INSTALL_START_SCRIPT).toBe(layout.START_SCRIPT);
    expect(markers.INSTALL_ICON).toBe(layout.ICON_FILE);
  });
});

describe('POSIX shell scripts (Linux, WP-108)', () => {
  it('use LF, /bin/sh, node from absolute PATH entries only and the right entry', () => {
    for (const text of [startShell('26.9.0'), installSh('26.9.0')]) {
      expect(text.startsWith('#!/bin/sh\n')).toBe(true);
      expect(text).not.toContain('\r');
      expect(text).toContain('/*) if [ -f "$dir/node" ] && [ -x "$dir/node" ]');
      expect(text).toContain('Node.js 26.9.0');
    }
    expect(startShell('26.9.0')).toContain(
      'exec "$node" --use-system-ca --use-env-proxy "$root/start.mjs" "$@"',
    );
    // Like install.cmd: no Node flags, install.js adds them after its version check.
    expect(installSh('26.9.0')).toContain('exec "$node" "$here/dist/install.js" "$@"');
    expect(installSh('26.9.0')).toContain('libatomic1');
  });

  it('the command names its root and runs the start script of that root', () => {
    const dir = "/home/demo/it's here/parallax";
    const text = commandScript(dir, `${dir}/parallax`);
    expect(commandScriptRoot(text)).toBe(dir);
    expect(text).toContain(`exec ${shellQuote(`${dir}/parallax`)} "$@"`);
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(commandScriptRoot('#!/bin/sh\necho foreign\n')).toBeNull();
    expect(commandScriptRoot(`#!/usr/bin/env bash\n# parallax-install-root: ${dir}\n`)).toBeNull();
  });

  const posix = it.runIf(process.platform !== 'win32');
  const shell = '/bin/sh';
  const nodePath = (): string => `${path.dirname(process.execPath)}:/usr/bin:/bin`;

  posix(
    'parallax runs start.mjs with the arguments, also through a link; without node it says so',
    async () => {
      const dir = await root();
      await writeFile(path.join(dir, START_SH), startShell('20.0.0'), { mode: 0o755 });
      const link = path.join(dir, 'link-to-parallax');
      await symlink(path.join(dir, START_SH), link);
      const result = await runFile(shell, [link, 'a b', '--autostart'], {
        cwd: os.tmpdir(),
        env: { PATH: `relative:${nodePath()}` },
        timeoutMs: 20_000,
      });
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      const ran = JSON.parse(await readFile(path.join(dir, 'ran.json'), 'utf8')) as { argv: string[] };
      expect(ran.argv).toEqual([`--install-root=${dir}`, 'a b', '--autostart']);

      const missing = await runFile(shell, [path.join(dir, START_SH)], {
        cwd: os.tmpdir(),
        env: { PATH: '/nonexistent' },
        timeoutMs: 20_000,
      });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain('Node.js 20.0.0 or newer');
    },
  );

  posix('install.sh checks the Node version, then runs dist/install.js with the arguments', async () => {
    const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp108-install-sh-'));
    temps.push(dir);
    await mkdir(path.join(dir, 'dist'));
    await writeFile(
      path.join(dir, 'dist', 'install.js'),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(path.join(dir, 'ran.json'))}, JSON.stringify(process.argv.slice(2)));`,
      ].join('\n'),
    );
    const run = async (minNode: string) => {
      await writeFile(path.join(dir, 'install.sh'), installSh(minNode));
      return runFile(shell, [path.join(dir, 'install.sh'), '--dir', '/opt/demo'], {
        cwd: os.tmpdir(),
        env: { PATH: nodePath() },
        timeoutMs: 20_000,
      });
    };
    const tooOld = await run('99.0.0');
    expect(tooOld.exitCode).toBe(1);
    expect(tooOld.stderr).toContain('Parallax needs Node.js 99.0.0 or newer');
    const [major = '0', minor = '0'] = process.versions.node.split('.');
    expect((await run(`${major}.${String(Number(minor) + 1)}.0`)).exitCode).toBe(1);
    const ok = await run(`${major}.${minor}.0`);
    expect(ok.stderr).toBe('');
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(await readFile(path.join(dir, 'ran.json'), 'utf8'))).toEqual(['--dir', '/opt/demo']);
  });
});
