import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PACKAGE_NODE_FLAGS } from '../launcher/release';
import { opensslNote, runInstallerCli, type InstallerCliDeps } from './cli';
import { defaultInstallRoot, readCurrent, START_SCRIPT } from './layout';
import { fakeProvideSdk, makeTestKey, makeTestPackage, type TestKey } from './testPackage';

const WINDOWS = process.platform === 'win32';
/** The data directory the messages name (never read or written here). */
const DATA_DIR = WINDOWS ? 'C:\\Users\\<USER>\\AppData\\Local\\Parallax' : '/home/demo/.local/share/parallax';

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
  /** Linux: the folders the fake `command` step was asked for. */
  commands: string[];
}

async function harness(version = '1.0.0', p: { flags?: boolean; lockBusy?: boolean } = {}): Promise<Harness> {
  const base = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp86-cli-'));
  temps.push(base);
  const key = makeTestKey();
  const ownDir = path.join(base, `parallax-${version}`);
  await makeTestPackage(ownDir, { version, key });
  // The default root of the platform below the test folder: %LOCALAPPDATA%\Programs\Parallax,
  // Linux $HOME/.local/lib/parallax – never the real one.
  const env: NodeJS.ProcessEnv = WINDOWS ? { LOCALAPPDATA: base } : { HOME: base };
  const root = defaultInstallRoot(env);
  if (root === null) throw new Error('no default installation root');
  const h: Omit<Harness, 'deps'> = {
    out: [],
    err: [],
    nodeRuns: [],
    locked: [],
    root,
    base,
    key,
    commands: [],
  };
  const deps: InstallerCliDeps = {
    env,
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
      ...(WINDOWS
        ? {}
        : {
            command: (installRoot: string) => {
              h.commands.push(installRoot);
              return Promise.resolve({ ok: true, file: path.join(base, '.local', 'bin', 'parallax') });
            },
          }),
      runningBuildId: () => Promise.resolve(null),
      log: (line) => h.out.push(line),
      removeEntries: () => Promise.resolve([]),
    }),
    dataDir: DATA_DIR,
    leave: () => undefined,
    keys: [key.x],
    out: (line) => h.out.push(line),
    fail: (line) => h.err.push(line),
  };
  return Object.assign(h, { deps });
}

describe('installer flow (WP-86, WP-83 §8.3)', () => {
  it('first installation into %LOCALAPPDATA%\\Programs\\Parallax (Linux ~/.local/lib/parallax)', async () => {
    const h = await harness();
    expect(await runInstallerCli([], h.deps)).toBe(0);
    expect(h.locked).toEqual([h.root]);
    expect((await readCurrent(h.root))?.version).toBe('1.0.0');
    if (WINDOWS) {
      expect(h.out.join('\n')).toMatch(
        /Parallax 1\.0\.0 is installed in .*Start Parallax from the Start menu/s,
      );
    } else {
      expect(h.commands).toEqual([h.root]);
      expect(h.out.join('\n')).toMatch(
        /Parallax 1\.0\.0 is installed in .*Start Parallax with ".*parallax" or from the application menu/s,
      );
    }
  });

  it('starts itself again with the network flags (install.cmd passes none)', async () => {
    const h = await harness('1.0.0', { flags: false });
    const dir = WINDOWS ? 'D:\\apps\\Parallax' : '/opt/demo/parallax';
    expect(await runInstallerCli(['--dir', dir], h.deps)).toBe(0);
    expect(h.nodeRuns).toEqual([[...PACKAGE_NODE_FLAGS, h.deps.installerScript, '--dir', dir]]);
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
    expect(h.out[0]).toMatch(WINDOWS ? /^Usage: install\.cmd/ : /^Usage: sh install\.sh/);
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
    expect(h.out.join('\n')).toMatch(/Parallax was removed from .*Your data stay in /s);
    expect(h.out.at(-1)).toContain(DATA_DIR);
  });

  it.runIf(!WINDOWS)('Linux: notes an OpenSSL older than 3.5 once per run from a package', async () => {
    const h = await harness();
    h.deps.opensslVersion = '3.0.13';
    expect(await runInstallerCli([], h.deps)).toBe(0);
    expect(h.out.filter((line) => line.includes('OpenSSL 3.0.13'))).toHaveLength(1);
    const fresh = await harness();
    fresh.deps.opensslVersion = '3.5.4';
    expect(await runInstallerCli([], fresh.deps)).toBe(0);
    expect(fresh.out.join('\n')).not.toContain('OpenSSL');
    expect(await readCurrent(fresh.root)).not.toBeNull();
  });
});

describe('opensslNote (WP-108)', () => {
  it('names an OpenSSL older than 3.5, else nothing', () => {
    expect(opensslNote('3.0.13')).toContain('OpenSSL 3.0.13');
    expect(opensslNote('3.0.13+quic')).toContain('OpenSSL 3.0.13');
    expect(opensslNote('3.5.0')).toBeNull();
    expect(opensslNote('3.6.1')).toBeNull();
    expect(opensslNote(undefined)).toBeNull();
    expect(opensslNote('unknown')).toBeNull();
  });
});
