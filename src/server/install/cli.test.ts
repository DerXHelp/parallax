import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PACKAGE_NODE_FLAGS } from '../launcher/release';
import { runInstallerCli, type InstallerCliDeps } from './cli';
import { readCurrent, START_SCRIPT } from './layout';
import { fakeProvideSdk, makeTestKey, makeTestPackage, type TestKey } from './testPackage';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Harness {
  deps: InstallerCliDeps;
  out: string[];
  err: string[];
  nodeRuns: (readonly string[])[];
  locked: string[];
  root: string;
  base: string;
  key: TestKey;
}

async function harness(version = '1.0.0', p: { flags?: boolean; lockBusy?: boolean } = {}): Promise<Harness> {
  const base = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp86-cli-'));
  temps.push(base);
  const key = makeTestKey();
  const ownDir = path.join(base, `parallax-${version}`);
  await makeTestPackage(ownDir, { version, key });
  const h: Omit<Harness, 'deps'> = {
    out: [],
    err: [],
    nodeRuns: [],
    locked: [],
    root: path.join(base, 'Programs', 'Parallax'),
    base,
    key,
  };
  const deps: InstallerCliDeps = {
    env: { LOCALAPPDATA: path.join(base) },
    cwd: base,
    ownDir,
    installerScript: path.join(ownDir, 'dist', 'install.js'),
    execArgv: p.flags === false ? [] : PACKAGE_NODE_FLAGS,
    nodeVersion: '26.12.0',
    runNode: (args) => {
      h.nodeRuns.push(args);
      return Promise.resolve(0);
    },
    lockRoot: async (root) => {
      h.locked.push(root);
      // Like acquireDirectoryLock: the folder is created for its real path.
      await mkdir(root, { recursive: true });
      return p.lockBusy === true ? null : { release: () => Promise.resolve() };
    },
    steps: () => ({
      provideSdk: fakeProvideSdk([]),
      startMenu: () => Promise.resolve(null),
      runningBuildId: () => Promise.resolve(null),
      log: (line) => h.out.push(line),
      removeEntries: () => Promise.resolve([]),
    }),
    dataDir: 'C:\\Users\\<USER>\\AppData\\Local\\Parallax',
    leave: () => undefined,
    keys: [key.x],
    out: (line) => h.out.push(line),
    fail: (line) => h.err.push(line),
  };
  return Object.assign(h, { deps });
}

describe('installer flow (WP-86, WP-83 §8.3)', () => {
  it('first installation into %LOCALAPPDATA%\\Programs\\Parallax', async () => {
    const h = await harness();
    expect(await runInstallerCli([], h.deps)).toBe(0);
    expect(h.locked).toEqual([h.root]);
    expect((await readCurrent(h.root))?.version).toBe('1.0.0');
    expect(h.out.join('\n')).toMatch(
      /Parallax 1\.0\.0 is installed in .*Start Parallax from the Start menu/s,
    );
  });

  it('starts itself again with the network flags (install.cmd passes none)', async () => {
    const h = await harness('1.0.0', { flags: false });
    expect(await runInstallerCli(['--dir', 'D:\\apps\\Parallax'], h.deps)).toBe(0);
    expect(h.nodeRuns).toEqual([
      [...PACKAGE_NODE_FLAGS, h.deps.installerScript, '--dir', 'D:\\apps\\Parallax'],
    ]);
    expect(h.locked).toEqual([]);
  });

  it('hands over to an existing installation, which checks the package with its own code', async () => {
    const first = await harness();
    await runInstallerCli([], first.deps);
    const second = await harness('1.1.0');
    second.deps.env = first.deps.env;
    expect(await runInstallerCli(['--registry', 'https://registry.example/'], second.deps)).toBe(0);
    expect(second.nodeRuns).toEqual([
      [
        ...PACKAGE_NODE_FLAGS,
        path.join(first.root, START_SCRIPT),
        '--install',
        second.deps.ownDir,
        '--registry',
        'https://registry.example/',
      ],
    ]);
    expect(second.out.join('\n')).toMatch(
      /Parallax 1\.0\.0 is installed in .* it checks and installs this package/,
    );
  });

  it('runs as the installed version with --install-root (no second hand-over)', async () => {
    const first = await harness();
    await runInstallerCli([], first.deps);
    const next = await harness('1.1.0');
    const installedOwn = { ...first.deps, ownDir: first.deps.ownDir };
    const code = await runInstallerCli([`--install-root=${first.root}`, '--install', next.deps.ownDir], {
      ...installedOwn,
      keys: [next.key.x],
    });
    expect(code).toBe(0);
    expect(first.nodeRuns).toEqual([]);
    expect(await readCurrent(first.root)).toEqual({ schemaVersion: 1, version: '1.1.0', previous: '1.0.0' });
  });

  it('help, bad options, a busy lock, no installation for --use, an old Node', async () => {
    const h = await harness();
    expect(await runInstallerCli(['--help'], h.deps)).toBe(0);
    expect(h.out[0]).toMatch(/^Usage: install\.cmd/);
    expect(await runInstallerCli(['--nope'], h.deps)).toBe(2);
    expect(await runInstallerCli(['--use', '1.0.0'], h.deps)).toBe(1);
    expect(h.err.at(-1)).toMatch(/There is no Parallax installation/);
    const busy = await harness('1.0.0', { lockBusy: true });
    expect(await runInstallerCli([], busy.deps)).toBe(1);
    expect(busy.err.at(-1)).toMatch(/Another Parallax installation/);
    const old = await harness();
    old.deps.nodeVersion = '26.4.0';
    expect(await runInstallerCli([], old.deps)).toBe(1);
    expect(old.err.at(-1)).toMatch(/needs Node\.js 26\.9\.0 or newer, this is 26\.4\.0/);
    expect(old.nodeRuns).toEqual([]);
  });

  it('a failed first installation leaves no empty root behind', async () => {
    const h = await harness();
    h.deps.keys = [makeTestKey().x];
    expect(await runInstallerCli([], h.deps)).toBe(1);
    expect(h.err.at(-1)).toMatch(/invalid signature/);
    await expect(access(h.root)).rejects.toThrow();
  });

  it('uninstalls and names the data directory', async () => {
    const h = await harness();
    await runInstallerCli([], h.deps);
    h.out.length = 0;
    expect(await runInstallerCli([`--install-root=${h.root}`, '--uninstall'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(
      /Parallax was removed from .*Your data stay in C:\\Users\\<USER>\\AppData\\Local\\Parallax/s,
    );
  });
});
