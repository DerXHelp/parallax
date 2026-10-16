/**
 * "Build if `dist` is missing or stale" for the launcher (Plan "Server-Betrieb", ADR-013/036):
 * the build id stamped into the first line of `dist/server.js` (scripts/build-server.ts) is
 * compared with the id the current checkout would get (`resolveBuildId()` of repo.config.ts,
 * injected by the caller). The build runs the same two steps as `pnpm build` (package.json
 * `build:web` + `build:server`), directly with node and the local tool binaries – no pnpm needed,
 * no shell. A test pins these steps to the package.json scripts.
 *
 * Build lock (R3-04, CR-08, ADR-092): one build per checkout at a time – a named-pipe mutex
 * (`acquireBuildLock`, `pollLock`) taken by the launcher, the E2E setup and `scripts/build-server.ts`
 * (`pnpm build:server`, the second step of `pnpm build`); `runBuild` expects its caller to hold it
 * and tells its child steps so (`BUILD_LOCK_HELD_ENV`).
 */
import { open, readFile, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { windowsPathIssue, windowsPathKey } from '@shared/paths';
import { WEB_BUILD_INFO_FILE, parseWebBuildId } from '../app/webSnapshot';
import { acquireKeyLock } from '../lib/homeLock';
import { runFile, type RunFileFn, type RunFileResult } from '../lib/process';

/** Relative to the repo root. */
export const SERVER_BUNDLE = path.join('dist', 'server.js');
export const WEB_INDEX = path.join('dist', 'web', 'index.html');
/** `dist/web/build.json` (repo.config.ts `WEB_BUILD_INFO_FILE`, pinned by a test). */
export const WEB_BUILD_INFO = path.join('dist', 'web', WEB_BUILD_INFO_FILE);

/** First line of the server bundle: `// Parallax server, build <id>` (scripts/build-server.ts banner). */
const BANNER = /^\/\/ \S+ server, build (\S+)\s*$/;

export function parseBundleBuildId(firstLine: string): string | null {
  return BANNER.exec(firstLine)?.[1] ?? null;
}

export interface BuildFs {
  /** First bytes of a file as UTF-8, or null if it does not exist. */
  readHead(file: string, bytes: number): Promise<string | null>;
  isFile(file: string): Promise<boolean>;
  /** Whole UTF-8 file or null. */
  readText(file: string): Promise<string | null>;
}

export const nodeBuildFs: BuildFs = {
  async readHead(file, bytes) {
    let handle: FileHandle;
    try {
      handle = await open(file, 'r');
    } catch {
      return null;
    }
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  },
  async isFile(file) {
    try {
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  },
  async readText(file) {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return null;
    }
  },
};

/** Build id of `dist/server.js`, or null if the bundle is missing or has no banner. */
export async function readBundleBuildId(repoRoot: string, fs: BuildFs = nodeBuildFs): Promise<string | null> {
  const head = await fs.readHead(path.join(repoRoot, SERVER_BUNDLE), 512);
  if (head === null) return null;
  return parseBundleBuildId(head.split(/\r?\n/, 1)[0] ?? '');
}

function isBuildIdResolver(value: unknown): value is (repoRoot: string) => unknown {
  return typeof value === 'function';
}

/**
 * The build id `pnpm build` would stamp now: `resolveBuildId(repoRoot)` of `repo.config.ts` (the
 * single implementation, ADR-013/036). The root config lies outside the server project (tsconfig
 * rootDir), so it is loaded at runtime – this works under tsx, which runs the launcher. Null if the
 * module cannot be loaded (then the caller rebuilds to be safe).
 */
export async function resolveCheckoutBuildId(repoRoot: string): Promise<string | null> {
  try {
    const mod: unknown = await import(pathToFileURL(path.join(repoRoot, 'repo.config.ts')).href);
    const resolve: unknown =
      typeof mod === 'object' && mod !== null ? Reflect.get(mod, 'resolveBuildId') : undefined;
    if (!isBuildIdResolver(resolve)) return null;
    const id: unknown = resolve(repoRoot);
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

export type BuildState =
  | { upToDate: true; buildId: string }
  | {
      upToDate: false;
      reason: 'missing' | 'stale' | 'unknown';
      bundled: string | null;
      expected: string | null;
    };

/** Build id of `dist/web` (`build.json`, vite.config.ts), or null if missing/unreadable. */
export async function readWebBundleBuildId(
  repoRoot: string,
  fs: BuildFs = nodeBuildFs,
): Promise<string | null> {
  const text = await fs.readText(path.join(repoRoot, WEB_BUILD_INFO));
  return text === null ? null : parseWebBuildId(text);
}

/**
 * Up to date = server bundle and web index exist, both bundles carry the same build id (a build that
 * stopped after `build:web` leaves them apart, ADR-066) and it equals `expected` (null = the current
 * id could not be determined → rebuild to be safe).
 */
export async function checkBuild(options: {
  repoRoot: string;
  expected: string | null;
  fs?: BuildFs;
}): Promise<BuildState> {
  const fs = options.fs ?? nodeBuildFs;
  const bundled = await readBundleBuildId(options.repoRoot, fs);
  const webOk = await fs.isFile(path.join(options.repoRoot, WEB_INDEX));
  if (bundled === null || !webOk)
    return { upToDate: false, reason: 'missing', bundled, expected: options.expected };
  if (options.expected === null) return { upToDate: false, reason: 'unknown', bundled, expected: null };
  if (bundled !== options.expected || (await readWebBundleBuildId(options.repoRoot, fs)) !== bundled)
    return { upToDate: false, reason: 'stale', bundled, expected: options.expected };
  return { upToDate: true, buildId: bundled };
}

export interface BuildStep {
  /** package.json script it mirrors. */
  script: 'build:web' | 'build:server';
  /** npm package that provides the binary. */
  pkg: string;
  bin: string;
  args: readonly string[];
}

/** `pnpm build` = `build:web && build:server` (order matters: the web build empties dist/web). */
export const BUILD_STEPS: readonly BuildStep[] = [
  { script: 'build:web', pkg: 'vite', bin: 'vite', args: ['build'] },
  {
    script: 'build:server',
    pkg: 'tsx',
    bin: 'tsx',
    args: ['--tsconfig', 'tsconfig.tools.json', 'scripts/build-server.ts'],
  },
];

const packageBinSchema = z.looseObject({
  bin: z.union([z.string().min(1), z.record(z.string(), z.string().min(1))]).optional(),
});

/** Absolute path of `bin` of `node_modules/<pkg>` (package.json `bin`), or null. */
export async function resolvePackageBin(
  repoRoot: string,
  pkg: string,
  bin: string,
  fs: BuildFs = nodeBuildFs,
): Promise<string | null> {
  const dir = path.join(repoRoot, 'node_modules', pkg);
  const text = await fs.readText(path.join(dir, 'package.json'));
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const parsed = packageBinSchema.safeParse(json);
  if (!parsed.success || parsed.data.bin === undefined) return null;
  const relative = typeof parsed.data.bin === 'string' ? parsed.data.bin : parsed.data.bin[bin];
  if (relative === undefined) return null;
  const file = path.resolve(dir, relative);
  return (await fs.isFile(file)) ? file : null;
}

/** Ten minutes per step (a cold Vite build with a virus scanner can take a while). */
export const BUILD_STEP_TIMEOUT_MS = 10 * 60_000;

export type BuildResult = { ok: true } | { ok: false; step: BuildStep['script']; output: string };

/** Only string values (runFile wants a complete `Record<string, string>`). */
export function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

// =====================================================================================
// Build lock (R3-04, CR-04, CR-08)
// =====================================================================================

/** Set to `1` for the child steps of `runBuild`: their caller holds the build lock (no deadlock). */
export const BUILD_LOCK_HELD_ENV = 'PARALLAX_BUILD_LOCK_HELD';
/** Another build may run both steps at their limit first. */
export const BUILD_LOCK_WAIT_MS = 2 * BUILD_STEP_TIMEOUT_MS + 5 * 60_000;
export const BUILD_LOCK_POLL_MS = 500;

/** One non-blocking try of a cross-process lock (named pipe, lib/homeLock.ts). */
export type LockAttempt = { kind: 'acquired'; release: () => Promise<void> } | { kind: 'busy' };

/**
 * Key of the build lock of a checkout (CR-04): the real path of a plain drive path (junctions and
 * `subst` drives share one lock). A path the data-directory rules refuse (`\\nas\share\…`, …) is
 * the checkout this process runs from – it is keyed by its resolved spelling, without any further
 * file system access (never a TypeError, the build still runs).
 */
export async function buildLockKey(
  repoRoot: string,
  fs: { realpath: (dir: string) => Promise<string> } = { realpath },
): Promise<string> {
  const resolved = path.win32.resolve(repoRoot);
  if (windowsPathIssue(resolved) !== null) return windowsPathKey(resolved);
  try {
    return windowsPathKey(await fs.realpath(resolved));
  } catch {
    return windowsPathKey(resolved);
  }
}

/** One try of the build lock of `repoRoot` (held until released or the process ends). */
export async function acquireBuildLock(
  repoRoot: string,
  options: { platform?: NodeJS.Platform } = {},
): Promise<LockAttempt> {
  const result = await acquireKeyLock('build', await buildLockKey(repoRoot), options);
  if (result.kind === 'busy') return { kind: 'busy' };
  const lock = result.lock;
  return { kind: 'acquired', release: () => lock.release() };
}

export interface LockPollOptions {
  waitMs: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Called once when the first try finds the lock busy. */
  onWaiting?: () => void;
}

/**
 * Takes a lock; if another holder has it, calls `onWaiting` once and polls until it is free or
 * `waitMs` passed (null). `waited` = it was busy at first (the caller re-checks what the other
 * holder may have done, e.g. built the same checkout).
 */
export async function pollLock(
  acquire: () => Promise<LockAttempt>,
  options: LockPollOptions,
): Promise<{ release: () => Promise<void>; waited: boolean } | null> {
  let attempt = await acquire();
  if (attempt.kind === 'acquired') return { release: attempt.release, waited: false };
  options.onWaiting?.();
  const deadline = options.now() + options.waitMs;
  for (;;) {
    if (options.now() >= deadline) return null;
    await options.sleep(options.pollMs);
    attempt = await acquire();
    if (attempt.kind === 'acquired') return { release: attempt.release, waited: true };
  }
}

/**
 * Runs BUILD_STEPS in order with `node <bin> <args>` in the repo root; stops at the first failure.
 * The caller holds the build lock (`acquireBuildLock`/`pollLock`); the steps get
 * `BUILD_LOCK_HELD_ENV=1`, so `scripts/build-server.ts` does not wait for it (CR-08).
 */
export async function runBuild(options: {
  repoRoot: string;
  /** node.exe (process.execPath). */
  nodePath: string;
  env: NodeJS.ProcessEnv;
  run?: RunFileFn;
  fs?: BuildFs;
  onStep?: (step: BuildStep) => void;
}): Promise<BuildResult> {
  const run = options.run ?? runFile;
  for (const step of BUILD_STEPS) {
    options.onStep?.(step);
    const bin = await resolvePackageBin(options.repoRoot, step.pkg, step.bin, options.fs);
    if (bin === null) {
      return { ok: false, step: step.script, output: `${step.pkg} is not installed - run "pnpm install".` };
    }
    let result: RunFileResult;
    try {
      result = await run(options.nodePath, [bin, ...step.args], {
        cwd: options.repoRoot,
        env: { ...stringEnv(options.env), [BUILD_LOCK_HELD_ENV]: '1' },
        timeoutMs: BUILD_STEP_TIMEOUT_MS,
      });
    } catch (error) {
      return { ok: false, step: step.script, output: error instanceof Error ? error.message : String(error) };
    }
    if (result.exitCode !== 0 || result.timedOut) {
      const output = `${result.stdout}\n${result.stderr}`.trim();
      return {
        ok: false,
        step: step.script,
        output: result.timedOut ? `timed out after ${String(BUILD_STEP_TIMEOUT_MS)} ms\n${output}` : output,
      };
    }
  }
  return { ok: true };
}
