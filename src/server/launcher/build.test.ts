import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { windowsPathKey } from '@shared/paths';
import { PRODUCT_NAME } from '@shared/product';
import type { RunFileFn, RunFileOptions } from '../lib/process';
import {
  BUILD_LOCK_HELD_ENV,
  BUILD_STEPS,
  SERVER_BUNDLE,
  WEB_BUILD_INFO,
  WEB_INDEX,
  acquireBuildLock,
  buildLockKey,
  buildUnderLock,
  checkBuild,
  parseBundleBuildId,
  pollLock,
  readBundleBuildId,
  readWebBundleBuildId,
  resolveCheckoutBuildId,
  resolvePackageBin,
  runBuild,
  stringEnv,
  type BuildFs,
  type LockAttempt,
} from './build';

// Real processes, git and a real server: generous limits, the machine may be busy (parallel checks).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROOT = 'C:\\repo';

function memoryFs(files: Readonly<Record<string, string>>): BuildFs {
  const byPath = new Map(Object.entries(files).map(([file, text]) => [path.resolve(ROOT, file), text]));
  return {
    readHead: (file, bytes) => Promise.resolve(byPath.get(path.resolve(file))?.slice(0, bytes) ?? null),
    isFile: (file) => Promise.resolve(byPath.has(path.resolve(file))),
    readText: (file) => Promise.resolve(byPath.get(path.resolve(file)) ?? null),
  };
}

const banner = (id: string) => `// ${PRODUCT_NAME} server, build ${id}\nimport x from 'y';\n`;
const webInfo = (id: string) => `${JSON.stringify({ buildId: id })}\n`;

describe('build id of dist/server.js (ADR-013)', () => {
  it('parses the banner line', () => {
    expect(parseBundleBuildId('// Parallax server, build 0.0.0+1082db7fa68c')).toBe('0.0.0+1082db7fa68c');
    expect(parseBundleBuildId('// Parallax server, build 0.0.0+abc.dirty-1234abcd\r')).toBe(
      '0.0.0+abc.dirty-1234abcd',
    );
    expect(parseBundleBuildId('import x from "y";')).toBeNull();
  });

  it('reads the id from the first line only', async () => {
    const fs = memoryFs({ [SERVER_BUNDLE]: banner('1.2.3+abc') });
    expect(await readBundleBuildId(ROOT, fs)).toBe('1.2.3+abc');
    expect(await readBundleBuildId(ROOT, memoryFs({}))).toBeNull();
    expect(await readBundleBuildId(ROOT, memoryFs({ [SERVER_BUNDLE]: 'x\n' + banner('1') }))).toBeNull();
  });

  it.each([
    ['nothing built', {}, '1+a', { upToDate: false, reason: 'missing' }],
    ['web missing', { [SERVER_BUNDLE]: banner('1+a') }, '1+a', { upToDate: false, reason: 'missing' }],
    [
      'stale',
      { [SERVER_BUNDLE]: banner('1+a'), [WEB_INDEX]: '<html>' },
      '1+b',
      { upToDate: false, reason: 'stale' },
    ],
    [
      'unknown id',
      { [SERVER_BUNDLE]: banner('1+a'), [WEB_INDEX]: '<html>' },
      null,
      { upToDate: false, reason: 'unknown' },
    ],
    [
      'web of another build (stopped after build:web, ADR-066)',
      { [SERVER_BUNDLE]: banner('1+a'), [WEB_INDEX]: '<html>', [WEB_BUILD_INFO]: webInfo('1+b') },
      '1+a',
      { upToDate: false, reason: 'stale' },
    ],
    [
      'web without build.json (built before R3)',
      { [SERVER_BUNDLE]: banner('1+a'), [WEB_INDEX]: '<html>' },
      '1+a',
      { upToDate: false, reason: 'stale' },
    ],
    [
      'current',
      { [SERVER_BUNDLE]: banner('1+a'), [WEB_INDEX]: '<html>', [WEB_BUILD_INFO]: webInfo('1+a') },
      '1+a',
      { upToDate: true, buildId: '1+a' },
    ],
  ] as const)('checkBuild: %s', async (_name, files, expected, state) => {
    expect(await checkBuild({ repoRoot: ROOT, expected, fs: memoryFs(files) })).toMatchObject(state);
  });

  it('reads the web build id; the file name is the one vite.config.ts writes (repo.config.ts)', async () => {
    expect(await readWebBundleBuildId(ROOT, memoryFs({ [WEB_BUILD_INFO]: webInfo('2+c') }))).toBe('2+c');
    expect(await readWebBundleBuildId(ROOT, memoryFs({ [WEB_BUILD_INFO]: '{' }))).toBeNull();
    expect(await readWebBundleBuildId(ROOT, memoryFs({}))).toBeNull();
    const config: unknown = await import(pathToFileURL(path.join(repoRoot, 'repo.config.ts')).href);
    const name: unknown =
      typeof config === 'object' && config !== null ? Reflect.get(config, 'WEB_BUILD_INFO_FILE') : null;
    expect(path.basename(WEB_BUILD_INFO)).toBe(name);
    const vite = await readFile(path.join(repoRoot, 'vite.config.ts'), 'utf8');
    expect(vite).toContain('fileName: WEB_BUILD_INFO_FILE');
  });

  it('the banner template of scripts/build-server.ts matches the parser', async () => {
    const script = await readFile(path.join(repoRoot, 'scripts', 'build-server.ts'), 'utf8');
    expect(script).toContain('banner: { js: `// ${PRODUCT_NAME} server, build ${buildId}` }');
  });

  it('computes the build id of the checkout with repo.config.ts', async () => {
    const id = await resolveCheckoutBuildId(repoRoot);
    expect(id).toMatch(/^\d+\.\d+\.\d+.*\+/);
    expect(await resolveCheckoutBuildId(path.join(repoRoot, 'does-not-exist'))).toBeNull();
  });
});

describe('build steps (= pnpm build)', () => {
  it('mirror the package.json scripts', async () => {
    const pkg = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')));
    // CR-08 (ADR-094): `pnpm build` runs both steps through buildUnderLock (one build lock).
    expect(pkg.scripts.build).toBe('tsx --tsconfig tsconfig.tools.json scripts/build.ts');
    const script = await readFile(path.join(repoRoot, 'scripts', 'build.ts'), 'utf8');
    expect(script).toContain('await buildUnderLock(');
    for (const step of BUILD_STEPS) {
      expect(pkg.scripts[step.script]).toBe([step.bin, ...step.args].join(' '));
    }
    expect(BUILD_STEPS.map((step) => step.script)).toEqual(['build:web', 'build:server']);
  });

  it('resolve the tool binaries of the real node_modules', async () => {
    for (const step of BUILD_STEPS) {
      const bin = await resolvePackageBin(repoRoot, step.pkg, step.bin);
      expect(bin).not.toBeNull();
      expect(path.isAbsolute(bin ?? '')).toBe(true);
    }
  });

  it('resolvePackageBin: string and map form, missing package or entry', async () => {
    const fs = memoryFs({
      'node_modules/tsx/package.json': JSON.stringify({ bin: './dist/cli.mjs' }),
      'node_modules/tsx/dist/cli.mjs': '',
      'node_modules/vite/package.json': JSON.stringify({ bin: { vite: 'bin/vite.js' } }),
      'node_modules/vite/bin/vite.js': '',
      'node_modules/broken/package.json': '{',
    });
    expect(await resolvePackageBin(ROOT, 'tsx', 'tsx', fs)).toBe(
      path.resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'),
    );
    expect(await resolvePackageBin(ROOT, 'vite', 'vite', fs)).toBe(
      path.resolve(ROOT, 'node_modules/vite/bin/vite.js'),
    );
    expect(await resolvePackageBin(ROOT, 'vite', 'other', fs)).toBeNull();
    expect(await resolvePackageBin(ROOT, 'broken', 'broken', fs)).toBeNull();
    expect(await resolvePackageBin(ROOT, 'missing', 'missing', fs)).toBeNull();
  });

  const toolsFs = memoryFs({
    'node_modules/tsx/package.json': JSON.stringify({ bin: './dist/cli.mjs' }),
    'node_modules/tsx/dist/cli.mjs': '',
    'node_modules/vite/package.json': JSON.stringify({ bin: { vite: 'bin/vite.js' } }),
    'node_modules/vite/bin/vite.js': '',
  });

  function recorder(exitCodes: number[]): {
    run: RunFileFn;
    calls: { file: string; args: readonly string[]; options: RunFileOptions }[];
  } {
    const calls: { file: string; args: readonly string[]; options: RunFileOptions }[] = [];
    const run: RunFileFn = (file, args, options) => {
      calls.push({ file, args, options });
      const exitCode = exitCodes[calls.length - 1] ?? 0;
      return Promise.resolve({
        exitCode,
        signal: null,
        stdout: 'out',
        stderr: exitCode === 0 ? '' : 'boom',
        timedOut: false,
      });
    };
    return { run, calls };
  }

  it('runBuild runs web then server with node, in the repo root, without a shell', async () => {
    const { run, calls } = recorder([0, 0]);
    const steps: string[] = [];
    const result = await runBuild({
      repoRoot: ROOT,
      nodePath: 'C:\\node\\node.exe',
      env: { PATH: 'C:\\x', EMPTY: undefined },
      run,
      fs: toolsFs,
      onStep: (step) => steps.push(step.script),
    });
    expect(result).toEqual({ ok: true });
    expect(steps).toEqual(['build:web', 'build:server']);
    expect(calls.map((call) => [call.file, ...call.args])).toEqual([
      ['C:\\node\\node.exe', path.resolve(ROOT, 'node_modules/vite/bin/vite.js'), 'build'],
      [
        'C:\\node\\node.exe',
        path.resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'),
        '--tsconfig',
        'tsconfig.tools.json',
        'scripts/build-server.ts',
      ],
    ]);
    expect(calls[0]?.options).toMatchObject({ cwd: ROOT, env: { PATH: 'C:\\x' } });
    // CR-08: the steps know that their caller holds the build lock (build-server.ts skips it).
    expect(calls.map((call) => call.options.env?.[BUILD_LOCK_HELD_ENV])).toEqual(['1', '1']);
  });

  it('runBuild stops at the first failing step with its output', async () => {
    const { run, calls } = recorder([1]);
    const result = await runBuild({
      repoRoot: ROOT,
      nodePath: 'C:\\node\\node.exe',
      env: {},
      run,
      fs: toolsFs,
    });
    expect(result).toEqual({ ok: false, step: 'build:web', output: 'out\nboom' });
    expect(calls).toHaveLength(1);
  });

  it('runBuild reports missing tools and spawn failures', async () => {
    const { run } = recorder([]);
    const missing = await runBuild({ repoRoot: ROOT, nodePath: 'n', env: {}, run, fs: memoryFs({}) });
    expect(missing).toMatchObject({ ok: false, step: 'build:web' });
    expect(missing.ok ? '' : missing.output).toContain('pnpm install');
    const failing: RunFileFn = () => Promise.reject(new Error('spawn ENOENT'));
    expect(await runBuild({ repoRoot: ROOT, nodePath: 'n', env: {}, run: failing, fs: toolsFs })).toEqual({
      ok: false,
      step: 'build:web',
      output: 'spawn ENOENT',
    });
  });

  it('stringEnv drops undefined values', () => {
    expect(stringEnv({ A: '1', B: undefined })).toEqual({ A: '1' });
  });

  it('CR-08: buildUnderLock waits for a busy lock, runs both steps under it, releases it (also on failure)', async () => {
    const events: string[] = [];
    const answers: LockAttempt[] = [{ kind: 'busy' }, { kind: 'busy' }];
    const release = (): Promise<void> => {
      events.push('release');
      return Promise.resolve();
    };
    const failing = { on: false };
    const run: RunFileFn = (_file, args) => {
      events.push(`run ${String(args.at(-1))}`);
      return Promise.resolve({
        exitCode: failing.on ? 1 : 0,
        signal: null,
        stdout: '',
        stderr: 'x',
        timedOut: false,
      });
    };
    const common = {
      repoRoot: ROOT,
      nodePath: 'n',
      env: {},
      run,
      fs: toolsFs,
      acquire: () => {
        const next = answers.shift() ?? { kind: 'acquired' as const, release };
        events.push(next.kind);
        return Promise.resolve(next);
      },
      onWaiting: () => events.push('waiting'),
      sleep: () => Promise.resolve(),
    };
    expect(await buildUnderLock(common)).toEqual({ ok: true });
    expect(events).toEqual([
      'busy',
      'waiting',
      'busy',
      'acquired',
      'run build',
      'run scripts/build-server.ts',
      'release',
    ]);
    events.length = 0;
    failing.on = true;
    const failed = await buildUnderLock(common);
    expect(failed).toMatchObject({ ok: false, step: 'build:web' });
    expect(events).toEqual(['acquired', 'run build', 'release']);
    // Without the lock in time: no step at all.
    const timedOut = await buildUnderLock({
      ...common,
      acquire: () => Promise.resolve({ kind: 'busy' }),
      waitMs: 0,
    });
    expect(timedOut).toMatchObject({ ok: false, step: 'lock' });
    // A caller that holds the lock (runBuild's children) builds at once.
    const held = await buildUnderLock({
      ...common,
      env: { [BUILD_LOCK_HELD_ENV]: '1' },
      acquire: () => Promise.reject(new Error('must not be called')),
    });
    expect(held).toMatchObject({ ok: false, step: 'build:web' });
  });

  it.runIf(process.platform === 'win32')(
    'CR-08: two builds of one checkout at the same time are serialized by the real lock (no mixed dist)',
    async () => {
      const root = path.join(ROOT, `cr08-${String(process.pid)}`);
      const steps: string[] = [];
      const slowRun =
        (name: string): RunFileFn =>
        async (_file, args) => {
          const step = String(args.at(-1));
          steps.push(`${name} start ${step}`);
          await new Promise((resolve) => setTimeout(resolve, 40));
          steps.push(`${name} end ${step}`);
          return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
        };
      const fsFor = (): BuildFs => ({
        ...toolsFs,
        readText: (file) => toolsFs.readText(path.resolve(ROOT, path.relative(root, file))),
        isFile: (file) => toolsFs.isFile(path.resolve(ROOT, path.relative(root, file))),
      });
      const options = (name: string) => ({
        repoRoot: root,
        nodePath: 'n',
        env: {},
        run: slowRun(name),
        fs: fsFor(),
        pollMs: 10,
      });
      const [a, b] = await Promise.all([buildUnderLock(options('A')), buildUnderLock(options('B'))]);
      expect([a, b]).toEqual([{ ok: true }, { ok: true }]);
      const first = steps[0]?.slice(0, 1) ?? '';
      const second = first === 'A' ? 'B' : 'A';
      // One build after the other: all four events of the first, then all of the second.
      expect(steps.map((s) => s.slice(0, 1))).toEqual([
        first,
        first,
        first,
        first,
        second,
        second,
        second,
        second,
      ]);
    },
  );
});

describe('build lock (R3-04, CR-04, CR-08)', () => {
  it('CR-04: a checkout on a UNC share is keyed by its spelling, without any file system access', async () => {
    const realpath = vi.fn((dir: string) => Promise.resolve(dir));
    expect(await buildLockKey('\\\\NAS\\share\\Parallax\\', { realpath })).toBe(
      windowsPathKey('\\\\nas\\share\\parallax'),
    );
    expect(await buildLockKey('//nas/share/parallax', { realpath })).toBe(
      await buildLockKey('\\\\NAS\\Share\\Parallax', { realpath }),
    );
    expect(realpath).not.toHaveBeenCalled();
    // A drive path: its real path (junctions, subst) – the same key as before (pipe name stable).
    realpath.mockResolvedValueOnce('D:\\Real\\Parallax');
    expect(await buildLockKey('S:\\Parallax', { realpath })).toBe('d:\\real\\parallax');
    expect(await buildLockKey('D:\\gone', { realpath: () => Promise.reject(new Error('ENOENT')) })).toBe(
      'd:\\gone',
    );
  });

  it.runIf(process.platform === 'win32')(
    'CR-04: the lock of a UNC checkout works (no TypeError) and is exclusive',
    async () => {
      const root = `\\\\nas-${String(process.pid)}\\share\\parallax`;
      const first = await acquireBuildLock(root);
      expect(first.kind).toBe('acquired');
      expect((await acquireBuildLock(root.toUpperCase())).kind).toBe('busy');
      if (first.kind === 'acquired') await first.release();
      const again = await acquireBuildLock(root);
      expect(again.kind).toBe('acquired');
      if (again.kind === 'acquired') await again.release();
    },
  );

  it('pollLock: busy → onWaiting once, polls until free; waited tells the caller to check again', async () => {
    const answers: LockAttempt[] = [{ kind: 'busy' }, { kind: 'busy' }];
    const release = vi.fn(() => Promise.resolve());
    const clock = { ms: 0 };
    const onWaiting = vi.fn();
    const lock = await pollLock(() => Promise.resolve(answers.shift() ?? { kind: 'acquired', release }), {
      waitMs: 10_000,
      pollMs: 500,
      sleep: (ms) => {
        clock.ms += ms;
        return Promise.resolve();
      },
      now: () => clock.ms,
      onWaiting,
    });
    expect(lock?.waited).toBe(true);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(clock.ms).toBe(1_000);
    const timedOut = await pollLock(() => Promise.resolve({ kind: 'busy' }), {
      waitMs: 1_000,
      pollMs: 500,
      sleep: (ms) => {
        clock.ms += ms;
        return Promise.resolve();
      },
      now: () => clock.ms,
    });
    expect(timedOut).toBeNull();
  });

  it('scripts/build-server.ts takes the lock unless runBuild holds it (CR-08)', async () => {
    const source = await readFile(path.join(repoRoot, 'scripts', 'build-server.ts'), 'utf8');
    expect(source).toContain('process.env[BUILD_LOCK_HELD_ENV]');
    expect(source).toContain('acquireBuildLock(repoRoot)');
  });
});
