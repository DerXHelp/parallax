import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_SDK_PACKAGE } from '../launcher/release';
import { installPackage, useVersion, type InstallDeps, type SdkRequest } from './install';
import {
  CURRENT_FILE,
  ICON_FILE,
  InstallError,
  START_CMD,
  START_SCRIPT,
  VERSIONS_DIR,
  defaultInstallRoot,
  readCurrent,
} from './layout';
import { startScript } from './templates';
import { fakeProvideSdk, makeTestKey, makeTestPackage, testBuildId, type TestKey } from './testPackage';

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
}

async function world(): Promise<World> {
  const base = await temp();
  const sdk: SdkRequest[] = [];
  const shortcuts: string[] = [];
  const lines: string[] = [];
  const running = { buildId: null as string | null };
  const key = makeTestKey();
  let minute = 0;
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
    async pkg(version, files, minNode) {
      const dir = path.join(base, 'download', `${version}-${String(minute++)}`, `parallax-${version}`);
      await makeTestPackage(dir, {
        version,
        key,
        ...(files ? { files } : {}),
        ...(minNode ? { minNode } : {}),
      });
      return dir;
    },
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
});
