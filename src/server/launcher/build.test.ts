import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PRODUCT_NAME } from '@shared/product';
import type { RunFileFn, RunFileOptions } from '../lib/process';
import {
  BUILD_STEPS,
  SERVER_BUNDLE,
  WEB_BUILD_INFO,
  WEB_INDEX,
  checkBuild,
  parseBundleBuildId,
  readBundleBuildId,
  readWebBundleBuildId,
  resolveCheckoutBuildId,
  resolvePackageBin,
  runBuild,
  stringEnv,
  type BuildFs,
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
    expect(pkg.scripts.build).toBe('pnpm run build:web && pnpm run build:server');
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
});
