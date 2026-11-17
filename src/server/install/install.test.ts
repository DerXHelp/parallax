import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_SDK_PACKAGE } from '../launcher/release';
import {
  installErrorReason,
  installPackage,
  packageRootFiles,
  restoreCurrent,
  stageVersion,
  switchVersion,
  useVersion,
  verifyVersion,
  type InstallDeps,
  type SdkRequest,
  type StageStep,
} from './install';
import {
  CURRENT_FILE,
  ICON_FILE,
  InstallError,
  PACKAGE_ROOT_DIR,
  START_CMD,
  START_SCRIPT,
  VERSIONS_DIR,
  defaultInstallRoot,
  readCurrent,
} from './layout';
import { SdkError } from './sdk';
import { startCmd, startScript } from './templates';
import {
  fakeProvideSdk,
  makeTestKey,
  makeTestPackage,
  testBuildId,
  type TestKey,
  type TestPackageOptions,
} from './testPackage';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp86-install-'));
  temps.push(dir);
  return dir;
}

interface World {
  root: string;
  base: string;
  key: TestKey;
  sdk: SdkRequest[];
  shortcuts: string[];
  lines: string[];
  running: { buildId: string | null };
  deps: InstallDeps;
  pkg(version: string, files?: Record<string, string>, minNode?: string): Promise<string>;
  pkgWith(version: string, extra: Omit<TestPackageOptions, 'version' | 'key'>): Promise<string>;
}

async function world(): Promise<World> {
  const base = await temp();
  const sdk: SdkRequest[] = [];
  const shortcuts: string[] = [];
  const lines: string[] = [];
  const running = { buildId: null as string | null };
  const key = makeTestKey();
  let minute = 0;
  const pkgWith = async (version: string, extra: Omit<TestPackageOptions, 'version' | 'key'>) => {
    const dir = path.join(base, 'download', `${version}-${String(minute++)}`, `parallax-${version}`);
    await makeTestPackage(dir, { version, key, ...extra });
    return dir;
  };
  return {
    root: path.join(base, 'Programs', 'Parallax'),
    base,
    key,
    sdk,
    shortcuts,
    lines,
    running,
    deps: {
      provideSdk: fakeProvideSdk(sdk),
      startMenu: (root) => {
        shortcuts.push(root);
        return Promise.resolve(null);
      },
      runningBuildId: () => Promise.resolve(running.buildId),
      log: (line) => lines.push(line),
      now: () => new Date(Date.UTC(2026, 10, 17, 9, minute++, 0)),
    },
    pkg: (version, files, minNode) =>
      pkgWith(version, { ...(files ? { files } : {}), ...(minNode ? { minNode } : {}) }),
    pkgWith,
  };
}

const install = (w: World, packageDir: string, extra: { keys?: string[]; nodeVersion?: string } = {}) =>
  installPackage(
    { packageDir, root: w.root, keys: extra.keys ?? [w.key.x], nodeVersion: extra.nodeVersion ?? '26.1.0' },
    w.deps,
  );

async function versions(root: string): Promise<string[]> {
  return (await readdir(path.join(root, VERSIONS_DIR))).sort();
}

describe('installPackage (WP-86, WP-83 §8.3)', () => {
  it('installs a checked package with the SDK, the root files, current.json and the Start menu entry', async () => {
    const w = await world();
    const result = await install(w, await w.pkg('1.0.0'));
    expect(result).toMatchObject({ version: '1.0.0', previous: null, reused: false, runningOther: null });
    expect(await versions(w.root)).toEqual(['1.0.0']);
    const dir = path.join(w.root, VERSIONS_DIR, '1.0.0');
    expect(await readFile(path.join(dir, 'dist', 'launcher.js'), 'utf8')).toContain(testBuildId('1.0.0'));
    const sdkJson = path.join(dir, 'node_modules', ...AGENT_SDK_PACKAGE.split('/'), 'package.json');
    expect(JSON.parse(await readFile(sdkJson, 'utf8'))).toMatchObject({ version: '0.3.322' });
    expect(w.sdk[0]).toMatchObject({
      cacheDir: path.join(w.root, 'cache'),
      tempDir: path.join(w.root, 'downloads'),
    });
    expect(await readCurrent(w.root)).toEqual({ schemaVersion: 1, version: '1.0.0', previous: null });
    expect(await readFile(path.join(w.root, START_SCRIPT), 'utf8')).toBe(startScript());
    expect(await readFile(path.join(w.root, START_CMD), 'utf8')).toContain('start.mjs');
    expect(await readFile(path.join(w.root, ICON_FILE), 'utf8')).toBe('icon 1.0.0');
    expect(w.shortcuts).toEqual([w.root]);
    expect(w.lines.join('\n')).toMatch(/Package checked: signature and 5 files/);
  });

  it('keeps the previous version, deletes older ones - but never the running one', async () => {
    const w = await world();
    await install(w, await w.pkg('1.0.0'));
    expect((await install(w, await w.pkg('1.1.0'))).previous).toBe('1.0.0');
    expect(await versions(w.root)).toEqual(['1.0.0', '1.1.0']);
    const third = await install(w, await w.pkg('1.2.0'));
    expect(third).toMatchObject({ previous: '1.1.0' });
    expect(third.cleanup.removed).toEqual(['1.0.0']);
    expect(await versions(w.root)).toEqual(['1.1.0', '1.2.0']);

    w.running.buildId = testBuildId('1.1.0');
    const fourth = await install(w, await w.pkg('1.3.0'));
    expect(fourth).toMatchObject({ previous: '1.2.0', runningOther: '1.1.0', runningForeign: false });
    expect(await versions(w.root)).toEqual(['1.1.0', '1.2.0', '1.3.0']);
    w.running.buildId = '0.9.0+checkout';
    expect((await install(w, await w.pkg('1.4.0'))).runningForeign).toBe(true);
  });

  it('keeps an intact version folder and replaces a damaged one', async () => {
    const w = await world();
    await install(w, await w.pkg('1.0.0'));
    const again = await install(w, await w.pkg('1.0.0'));
    expect(again).toMatchObject({ reused: true, previous: null });
    expect(w.sdk).toHaveLength(1);

    await writeFile(path.join(w.root, VERSIONS_DIR, '1.0.0', 'dist', 'launcher.js'), 'changed');
    const repaired = await install(w, await w.pkg('1.0.0'));
    expect(repaired.reused).toBe(false);
    expect(w.sdk).toHaveLength(2);
    expect(await readFile(path.join(w.root, VERSIONS_DIR, '1.0.0', 'dist', 'launcher.js'), 'utf8')).toContain(
      'build',
    );
    expect(await versions(w.root)).toEqual(['1.0.0']);
  });

  it('refuses a foreign signature, a changed or extra file, a link and an old Node - root untouched', async () => {
    const w = await world();
    const other = makeTestKey();
    await expect(install(w, await w.pkg('1.0.0'), { keys: [other.x] })).rejects.toThrow(/invalid signature/);

    const changed = await w.pkg('1.0.0');
    await writeFile(path.join(changed, 'dist', 'install.js'), '// evil\n');
    await expect(install(w, changed)).rejects.toThrow(/dist\/install\.js: changed/);

    const extra = await w.pkg('1.0.0');
    await writeFile(path.join(extra, 'dist', 'extra.js'), '');
    await expect(install(w, extra)).rejects.toThrow(/dist\/extra\.js: not in release\.json/);

    await expect(install(w, await w.pkg('1.0.0'), { nodeVersion: '24.4.1' })).rejects.toThrow(
      /needs Node\.js 24\.5\.0 or newer, this is 24\.4\.1/,
    );
    await expect(readdir(w.root)).rejects.toThrow();
  });

  it('a failed SDK step leaves no version folder, no staging and the old current.json', async () => {
    const w = await world();
    await install(w, await w.pkg('1.0.0'));
    w.deps.provideSdk = () => Promise.reject(new InstallError('no registry reachable'));
    await expect(install(w, await w.pkg('1.1.0'))).rejects.toThrow(/no registry reachable/);
    expect(await versions(w.root)).toEqual(['1.0.0']);
    expect((await readCurrent(w.root))?.version).toBe('1.0.0');
  });

  it('a damaged current.json is written again', async () => {
    const w = await world();
    await install(w, await w.pkg('1.0.0'));
    await writeFile(path.join(w.root, CURRENT_FILE), '{');
    expect((await install(w, await w.pkg('1.1.0'))).previous).toBeNull();
    expect(w.lines.join('\n')).toMatch(/current\.json is damaged - it is written again/);
  });

  it('never touches the real installation folder in a test run', async () => {
    const w = await world();
    const real =
      defaultInstallRoot(process.env) ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Parallax');
    await expect(
      installPackage({ packageDir: await w.pkg('1.0.0'), root: real, keys: [w.key.x] }, w.deps),
    ).rejects.toThrow(/tests must not use the real folder/);
  });
});

describe('useVersion (--use)', () => {
  it('switches to an installed version and back; an unknown one is refused', async () => {
    const w = await world();
    await install(w, await w.pkg('1.0.0'));
    await install(w, await w.pkg('1.1.0'));
    expect(await useVersion(w.root, '1.0.0', w.deps)).toMatchObject({ previous: '1.1.0', unchanged: false });
    expect(await readCurrent(w.root)).toEqual({ schemaVersion: 1, version: '1.0.0', previous: '1.1.0' });
    expect((await useVersion(w.root, '1.0.0', w.deps)).unchanged).toBe(true);
    await expect(useVersion(w.root, '2.0.0', w.deps)).rejects.toThrow(
      /2\.0\.0 is not installed .*Installed: 1\.0\.0, 1\.1\.0/,
    );
  });

  it('takes the root files from the version folder', async () => {
    const w = await world();
    await install(w, await w.pkg('1.0.0'));
    await install(w, await w.pkgWith('1.1.0', { files: { 'root/start.mjs': '// start 1.1.0\n' } }));
    expect(await readFile(path.join(w.root, START_SCRIPT), 'utf8')).toBe('// start 1.1.0\n');
    await useVersion(w.root, '1.0.0', w.deps);
    expect(await readFile(path.join(w.root, START_SCRIPT), 'utf8')).toBe(startScript());
  });
});

/** Rejection of `promise` (fails when it resolves). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

describe('stageVersion (WP-87 §1.9)', () => {
  const stage = (
    w: World,
    packageDir: string,
    extra: { signal?: AbortSignal; events?: [StageStep, number, number][]; keys?: string[] } = {},
  ) =>
    stageVersion(
      {
        packageDir,
        root: w.root,
        keys: extra.keys ?? [w.key.x],
        nodeVersion: '26.1.0',
        ...(extra.signal ? { signal: extra.signal } : {}),
        onProgress: (step, done, total) => extra.events?.push([step, done, total]),
      },
      w.deps,
    );

  it('stages a version without switching and reports check, copy and SDK progress', async () => {
    const w = await world();
    const pkg = await w.pkg('1.0.0');
    const events: [StageStep, number, number][] = [];
    const result = await stage(w, pkg, { events });
    const dir = path.join(w.root, VERSIONS_DIR, '1.0.0');
    expect(result).toMatchObject({ dir, reused: false, release: { version: '1.0.0' } });
    expect(result.bytes.equals(await readFile(path.join(pkg, 'release.json')))).toBe(true);
    expect(await versions(w.root)).toEqual(['1.0.0']);
    expect(await readCurrent(w.root)).toBeNull();
    expect(await exists(path.join(w.root, START_SCRIPT))).toBe(false);
    expect(w.shortcuts).toEqual([]);

    // 5 listed files + release.json + signature.
    const steps = events.map(([step]) => step);
    expect([...new Set(steps)]).toEqual(['check', 'copy', 'sdk']);
    expect(events.filter(([step]) => step === 'check').at(-1)).toEqual(['check', 7, 7]);
    const copy = events.filter(([step]) => step === 'copy');
    expect(copy[0]).toEqual(['copy', 0, 14]);
    expect(copy.at(-1)).toEqual(['copy', 14, 14]);
    expect(copy.every(([, done], index) => index === 0 || done >= (copy[index - 1]?.[1] ?? 0))).toBe(true);
    expect(events.slice(-2)).toEqual([
      ['sdk', 0, 1],
      ['sdk', 1, 1],
    ]);
  });

  it('keeps an intact version folder (reused: only the check, no SDK step)', async () => {
    const w = await world();
    await stage(w, await w.pkg('1.0.0'));
    const events: [StageStep, number, number][] = [];
    const again = await stage(w, await w.pkg('1.0.0'), { events });
    expect(again.reused).toBe(true);
    expect(w.sdk).toHaveLength(1);
    expect(new Set(events.map(([step]) => step))).toEqual(new Set(['check']));
  });

  it('an abort leaves neither staging nor version folder', async () => {
    const w = await world();
    const controller = new AbortController();
    const error = await rejection(
      stageVersion(
        {
          packageDir: await w.pkg('1.0.0'),
          root: w.root,
          keys: [w.key.x],
          signal: controller.signal,
          onProgress: (step) => {
            if (step === 'copy') controller.abort();
          },
        },
        w.deps,
      ),
    );
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(await readdir(path.join(w.root, VERSIONS_DIR))).toEqual([]);
    expect(w.sdk).toHaveLength(0);

    const before = new AbortController();
    before.abort();
    await expect(stage(w, await w.pkg('1.0.0'), { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('names the reason of a failure', async () => {
    const w = await world();
    const reason = async (promise: Promise<unknown>) => installErrorReason(await rejection(promise));
    expect(await reason(stage(w, await w.pkg('1.0.0'), { keys: [makeTestKey().x] }))).toBe('signature');
    const unsigned = await w.pkg('1.0.0');
    await rm(path.join(unsigned, 'release.json.sig'));
    expect(await reason(stage(w, unsigned))).toBe('signature');
    expect(
      await reason(
        stageVersion(
          { packageDir: await w.pkg('1.0.0'), root: w.root, keys: [w.key.x], nodeVersion: '24.4.1' },
          w.deps,
        ),
      ),
    ).toBe('node');
    const changed = await w.pkg('1.0.0');
    await writeFile(path.join(changed, 'dist', 'install.js'), '// evil\n');
    expect(await reason(stage(w, changed))).toBe('files');
    expect(await reason(stage(w, path.join(w.base, 'nowhere')))).toBe('files');

    w.deps.provideSdk = () => Promise.reject(new SdkError('no registry reachable'));
    expect(await reason(stage(w, await w.pkg('1.0.0')))).toBe('sdk');
    expect(await readdir(path.join(w.root, VERSIONS_DIR))).toEqual([]);
  });
});

describe('installErrorReason', () => {
  it('maps InstallError, SdkError and anything else', () => {
    expect(installErrorReason(new InstallError('x', { reason: 'in_use' }))).toBe('in_use');
    expect(installErrorReason(new InstallError('x'))).toBe('io');
    expect(installErrorReason(new SdkError('x'))).toBe('sdk');
    expect(installErrorReason(new Error('x'))).toBe('io');
    expect(installErrorReason('x')).toBe('io');
  });
});

describe('switchVersion and restoreCurrent (WP-87 §1.9)', () => {
  const quiet = { log: () => undefined };

  it('switches to a staged version with its root files and goes back byte for byte', async () => {
    const w = await world();
    await install(w, await w.pkg('1.0.0'));
    const currentBefore = await readFile(path.join(w.root, CURRENT_FILE));
    const cmdBefore = await readFile(path.join(w.root, START_CMD));
    await stageVersion(
      {
        packageDir: await w.pkgWith('1.1.0', {
          rootFiles: true,
          files: { 'root/start.mjs': '// start 1.1.0\n', 'parallax.ico': 'icon 1.1.0' },
        }),
        root: w.root,
        keys: [w.key.x],
      },
      w.deps,
    );

    const result = await switchVersion(w.root, '1.1.0', { previous: '1.0.0', ...quiet });
    expect(result).toEqual({
      previous: '1.0.0',
      before: { schemaVersion: 1, version: '1.0.0', previous: null },
    });
    expect(await readCurrent(w.root)).toEqual({ schemaVersion: 1, version: '1.1.0', previous: '1.0.0' });
    expect(await readFile(path.join(w.root, START_SCRIPT), 'utf8')).toBe('// start 1.1.0\n');
    expect(await readFile(path.join(w.root, START_CMD), 'utf8')).toBe(startCmd('24.5.0'));
    expect(await readFile(path.join(w.root, ICON_FILE), 'utf8')).toBe('icon 1.1.0');

    await restoreCurrent(w.root, result.before);
    expect((await readFile(path.join(w.root, CURRENT_FILE))).equals(currentBefore)).toBe(true);
    expect(await readFile(path.join(w.root, START_SCRIPT), 'utf8')).toBe(startScript());
    expect((await readFile(path.join(w.root, START_CMD))).equals(cmdBefore)).toBe(true);
    expect(await readFile(path.join(w.root, ICON_FILE), 'utf8')).toBe('icon 1.0.0');
  });

  it('defaults previous like the installer; restoring "none" deletes current.json', async () => {
    const w = await world();
    await install(w, await w.pkg('1.0.0'));
    await install(w, await w.pkg('1.1.0'));
    expect((await switchVersion(w.root, '1.0.0', quiet)).previous).toBe('1.1.0');
    expect((await switchVersion(w.root, '1.0.0', quiet)).previous).toBe('1.1.0');
    expect((await switchVersion(w.root, '1.1.0', { previous: null, ...quiet })).previous).toBeNull();

    await writeFile(path.join(w.root, CURRENT_FILE), '{');
    const lines: string[] = [];
    const damaged = await switchVersion(w.root, '1.0.0', { log: (line) => lines.push(line) });
    expect(damaged).toEqual({ previous: null, before: null });
    expect(lines.join('\n')).toMatch(/current\.json is damaged/);
    await restoreCurrent(w.root, null);
    expect(await exists(path.join(w.root, CURRENT_FILE))).toBe(false);
  });

  it('refuses a version that is not installed and leaves current.json alone', async () => {
    const w = await world();
    await install(w, await w.pkg('1.0.0'));
    const error = await rejection(switchVersion(w.root, '2.0.0', quiet));
    expect(error).toBeInstanceOf(InstallError);
    expect(installErrorReason(error)).toBe('files');
    expect((await readCurrent(w.root))?.version).toBe('1.0.0');
  });
});

describe('verifyVersion (WP-87 §1.9)', () => {
  const sdkJson = (root: string, version: string) =>
    path.join(root, VERSIONS_DIR, version, 'node_modules', ...AGENT_SDK_PACKAGE.split('/'), 'package.json');

  it('accepts an intact version folder and returns its release', async () => {
    const w = await world();
    await install(w, await w.pkg('1.0.0'));
    expect(await verifyVersion(w.root, '1.0.0', [w.key.x])).toMatchObject({
      version: '1.0.0',
      buildId: testBuildId('1.0.0'),
    });
  });

  it.each<[string, (w: World, dir: string) => Promise<unknown>, string, RegExp]>([
    ['a foreign key', () => Promise.resolve(), 'signature', /invalid signature/],
    [
      'a changed file',
      (_w, dir) => writeFile(path.join(dir, 'dist', 'launcher.js'), 'changed'),
      'files',
      /dist\/launcher\.js: changed/,
    ],
    [
      'an extra file',
      (_w, dir) => writeFile(path.join(dir, 'dist', 'extra.js'), ''),
      'files',
      /dist\/extra\.js: not in release\.json/,
    ],
    ['a missing file', (_w, dir) => rm(path.join(dir, 'install.cmd')), 'files', /install\.cmd: missing/],
    [
      'another SDK version',
      (w) =>
        writeFile(sdkJson(w.root, '1.0.0'), JSON.stringify({ name: AGENT_SDK_PACKAGE, version: '0.3.999' })),
      'sdk',
      /0\.3\.999, release\.json names/,
    ],
    ['a missing SDK', (w) => rm(sdkJson(w.root, '1.0.0')), 'sdk', /Agent SDK .* is missing or damaged/],
  ])('refuses %s', async (name, damage, reason, message) => {
    const w = await world();
    await install(w, await w.pkg('1.0.0'));
    await damage(w, path.join(w.root, VERSIONS_DIR, '1.0.0'));
    const keys = name === 'a foreign key' ? [makeTestKey().x] : [w.key.x];
    const error = await rejection(verifyVersion(w.root, '1.0.0', keys));
    expect(error).toBeInstanceOf(InstallError);
    expect(installErrorReason(error)).toBe(reason);
    expect(String(error)).toMatch(message);
  });

  it('refuses a version that is not there', async () => {
    const w = await world();
    await install(w, await w.pkg('1.0.0'));
    expect(installErrorReason(await rejection(verifyVersion(w.root, '1.1.0', [w.key.x])))).toBe('files');
  });
});

describe('root files from the package (WP-87 §1.9)', () => {
  it('packageRootFiles are the templates below root/', () => {
    expect(packageRootFiles('24.5.0')).toEqual({
      [`${PACKAGE_ROOT_DIR}/${START_SCRIPT}`]: startScript(),
      [`${PACKAGE_ROOT_DIR}/${START_CMD}`]: startCmd('24.5.0'),
    });
  });

  it('the installer writes start.mjs and parallax.cmd from root/ of the package', async () => {
    const w = await world();
    await install(
      w,
      await w.pkgWith('1.0.0', {
        rootFiles: true,
        files: { 'root/parallax.cmd': '@rem 1.0.0\r\n' },
      }),
    );
    expect(await readFile(path.join(w.root, START_SCRIPT), 'utf8')).toBe(startScript());
    expect(await readFile(path.join(w.root, START_CMD), 'utf8')).toBe('@rem 1.0.0\r\n');
    expect(w.lines.join('\n')).toMatch(/Package checked: signature and 7 files/);
  });
});
