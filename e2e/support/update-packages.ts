/**
 * Update E2E (WP-89e): test builds and signed release packages for `e2e/update.spec.ts`.
 *
 * - **Builds** per package version: the update test bundles (`scripts/build-server.ts --update-test`,
 *   `__PARALLAX_UPDATE_TEST__` on: release server, keys and registry from the environment) and the
 *   web UI, both with the build id `<version>+e2e.<key>` (`PARALLAX_BUILD_ID`) – a window only
 *   reconnects to a server of its own build, another one makes it reload. Cached below
 *   `node_modules/.cache/parallax-update-e2e/<key>/` (`key` = digest of the checkout's build id;
 *   Playwright empties `test-results/` at every start), built under the build lock of the checkout.
 * - **Packages** like `scripts/release-pack.ts`, but without `node_modules` (module resolution walks
 *   up to `<repo>\node_modules`, so packages and root live below `<repo>\test-results\`): `dist/`,
 *   `root/start.mjs` + `root/parallax.cmd`, `CHANGELOG.md` with sections of the test versions,
 *   `LICENSE`, notices, `install.cmd`, the icon, a short `package.json`; `release.json` with the real
 *   store schema hashes and the SDK of the mini tarball, signed with a test key (`makeTestKey`).
 * - **SDK**: a mini tarball (only `package/package.json`) – the installation's cache gets it, a
 *   fake registry serves it; no network, no npm with internet.
 */
import { createHash, sign } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareVersions } from '@shared/version';
import {
  BUILD_LOCK_HELD_ENV,
  BUILD_LOCK_POLL_MS,
  BUILD_LOCK_WAIT_MS,
  acquireBuildLock,
  checkBuild,
  pollLock,
  resolveCheckoutBuildId,
  resolvePackageBin,
  stringEnv,
} from '../../src/server/launcher/build';
import { hashFiles, walkPackage } from '../../src/server/launcher/packageFiles';
import {
  AGENT_SDK_PACKAGE,
  RELEASE_FILE,
  RELEASE_SCHEMA_VERSION,
  RELEASE_SIGNATURE_FILE,
  releaseInfoSchema,
  type ReleaseInfo,
} from '../../src/server/launcher/release';
import { packageRootFiles } from '../../src/server/install/install';
import { ICON_FILE, INSTALL_CMD } from '../../src/server/install/layout';
import { sha512Integrity } from '../../src/server/install/sdk';
import { installCmd } from '../../src/server/install/templates';
import type { TestKey } from '../../src/server/install/testPackage';
import { sleep } from '../../src/server/lib/async';
import { runFile, systemTool } from '../../src/server/lib/process';
import { storeSchemaHashes } from '../../src/server/store/schemas';
import { archiveFolders, archivePath } from '../../src/server/update/testRelease';
import { REPO_ROOT } from './paths';

const CACHE_ROOT = path.join(REPO_ROOT, 'node_modules', '.cache', 'parallax-update-e2e');
/** One Vite or esbuild step (a cold Vite build with a virus scanner can take a while). */
const BUILD_STEP_TIMEOUT_MS = 8 * 60_000;
export const MIN_NODE = '26.9.0';
/** The Agent SDK version of this checkout (package.json pins it exactly). */
export const SDK_VERSION = '0.3.322';

export interface TestBuild {
  version: string;
  buildId: string;
  /** Folder with `dist/` (server.js, launcher.js, install.js, web/). */
  dir: string;
}

/** Env of a build step: no inherited PARALLAX_* (test home, port), the build id, the lock held. */
function buildEnv(buildId: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(stringEnv(process.env)).filter(([key]) => !key.toUpperCase().startsWith('PARALLAX')),
  );
  return { ...env, PARALLAX_BUILD_ID: buildId, [BUILD_LOCK_HELD_ENV]: '1' };
}

async function runStep(label: string, args: readonly string[], buildId: string): Promise<void> {
  const result = await runFile(process.execPath, [...args], {
    cwd: REPO_ROOT,
    env: buildEnv(buildId),
    timeoutMs: BUILD_STEP_TIMEOUT_MS,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      `${label} for ${buildId} failed (${result.timedOut ? 'timeout' : `exit ${String(result.exitCode)}`}):\n` +
        `${result.stdout}\n${result.stderr}`.trim(),
    );
  }
}

async function bin(pkg: string, name: string): Promise<string> {
  const file = await resolvePackageBin(REPO_ROOT, pkg, name);
  if (file === null) throw new Error(`${pkg} is not installed - run pnpm install`);
  return file;
}

async function isComplete(dir: string, buildId: string): Promise<boolean> {
  const state = await checkBuild({ repoRoot: dir, expected: buildId });
  if (!state.upToDate) return false;
  const names = await readdir(path.join(dir, 'dist')).catch((): string[] => []);
  return names.includes('launcher.js') && names.includes('install.js');
}

/**
 * The test builds of `versions` (server bundles + web UI per version), from the cache or built now.
 * `log` gets one line per build step.
 */
export async function ensureTestBuilds(
  versions: readonly string[],
  log: (line: string) => void,
): Promise<TestBuild[]> {
  const checkout = await resolveCheckoutBuildId(REPO_ROOT);
  if (checkout === null) throw new Error('the build id of this checkout is unknown');
  const key = createHash('sha256').update(checkout).digest('hex').slice(0, 12);
  const keyDir = path.join(CACHE_ROOT, key);
  const builds = versions.map((version) => {
    const buildId = `${version}+e2e.${key}`;
    return { version, buildId, dir: path.join(keyDir, version) };
  });
  const missing: TestBuild[] = [];
  for (const build of builds) if (!(await isComplete(build.dir, build.buildId))) missing.push(build);
  if (missing.length === 0) return builds;

  const lock = await pollLock(() => acquireBuildLock(REPO_ROOT), {
    waitMs: BUILD_LOCK_WAIT_MS,
    pollMs: BUILD_LOCK_POLL_MS,
    sleep,
    now: () => Date.now(),
    onWaiting: () => {
      log('another build of this checkout is running - waiting for it');
    },
  });
  if (lock === null) throw new Error('another build of this checkout did not finish in time');
  try {
    // Builds of older checkouts go (one key at a time).
    for (const name of await readdir(CACHE_ROOT).catch((): string[] => [])) {
      if (name !== key) await rm(path.join(CACHE_ROOT, name), { recursive: true, force: true });
    }
    const vite = await bin('vite', 'vite');
    const tsx = await bin('tsx', 'tsx');
    for (const build of missing) {
      if (await isComplete(build.dir, build.buildId)) continue;
      const tmp = `${build.dir}.tmp-${String(process.pid)}`;
      await rm(tmp, { recursive: true, force: true });
      await rm(build.dir, { recursive: true, force: true });
      const started = Date.now();
      log(`building the web UI ${build.buildId}`);
      await runStep(
        'vite build',
        [vite, 'build', '--outDir', path.join(tmp, 'dist', 'web'), '--emptyOutDir', '--logLevel', 'warn'],
        build.buildId,
      );
      log(`building the update test bundles ${build.buildId}`);
      await runStep(
        'build-server --update-test',
        [
          tsx,
          '--tsconfig',
          'tsconfig.tools.json',
          'scripts/build-server.ts',
          '--update-test',
          `--out-dir=${path.join(tmp, 'dist')}`,
        ],
        build.buildId,
      );
      if (!(await isComplete(tmp, build.buildId))) throw new Error(`${tmp}: the build is incomplete`);
      await rename(tmp, build.dir);
      log(`built ${build.buildId} in ${String(Math.round((Date.now() - started) / 1000))} s`);
    }
  } finally {
    await lock.release();
  }
  return builds;
}

// ---- SDK ----

export interface MiniSdk {
  /** `package/package.json` only, gzipped tar like `npm pack`. */
  tarball: string;
  bytes: Buffer;
  spec: ReleaseInfo['sdk'];
}

export async function makeMiniSdk(dir: string): Promise<MiniSdk> {
  const source = path.join(dir, 'source');
  await mkdir(path.join(source, 'package'), { recursive: true });
  await writeFile(
    path.join(source, 'package', 'package.json'),
    `${JSON.stringify({ name: AGENT_SDK_PACKAGE, version: SDK_VERSION }, null, 2)}\n`,
  );
  const tarball = path.join(
    dir,
    `${AGENT_SDK_PACKAGE.replace(/^@/u, '').replace('/', '-')}-${SDK_VERSION}.tgz`,
  );
  const tar = systemTool(process.platform === 'win32' ? 'tar.exe' : 'tar');
  const result = await runFile(tar, ['-c', '-z', '-f', tarball, '-C', source, 'package'], {
    cwd: source,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr}`);
  return {
    tarball,
    bytes: await readFile(tarball),
    spec: { name: AGENT_SDK_PACKAGE, version: SDK_VERSION, integrity: await sha512Integrity(tarball) },
  };
}

/** A well-formed integrity that matches no tarball of the test (UPDATE_SDK_FAILED). */
export function wrongIntegrity(): string {
  return `sha512-${createHash('sha512').update('not the mini sdk').digest('base64')}`;
}

// ---- packages ----

/** The body of the section of `version` in `changelogUpTo` (also latest.json `notes`). */
export function notesOf(version: string): string {
  return `### Neu\n- Testversion ${version} des Update-E2E.`;
}

/** CHANGELOG.md with the sections of every test version up to `version` (newest first). */
export function changelogUpTo(version: string, versions: readonly string[]): string {
  const sections = versions
    .filter((v) => (compareVersions(v, version) ?? 1) <= 0)
    .sort((a, b) => compareVersions(b, a) ?? 0)
    .map((v) => `## [${v}] – 2026-11-2${v.split('.').at(-1) ?? '0'}\n\n${notesOf(v)}\n`);
  return ['# Changelog', '', 'Testpakete des Update-E2E (WP-89e).', '', ...sections].join('\n');
}

export interface PackageSpec {
  version: string;
  buildId: string;
  key: TestKey;
  sdk: ReleaseInfo['sdk'];
  /** `dist/` to copy (a test build); none = only the files below. */
  distFrom?: string;
  /** `/`-separated path → content (replaces a copied file); null removes a copied file. */
  files?: Record<string, string | null>;
  /** All test versions (for the changelog). */
  versions: readonly string[];
}

export interface TestPackage {
  version: string;
  /** `<out>\parallax-<v>` */
  dir: string;
  release: ReleaseInfo;
  /** The release archive of this host next to the folder (`parallax-<v>-win.zip`, Linux `…-linux-x64.tar.gz`). */
  archive: () => Promise<{ file: string; bytes: Buffer }>;
}

/** Writes `<out>\parallax-<version>\` like release-pack (without node_modules) and signs release.json. */
export async function writeTestPackage(out: string, spec: PackageSpec): Promise<TestPackage> {
  const dir = path.join(out, `parallax-${spec.version}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  if (spec.distFrom !== undefined) {
    await cp(spec.distFrom, path.join(dir, 'dist'), { recursive: true });
  }
  const files: Record<string, string | Buffer | null> = {
    'package.json': `${JSON.stringify(
      {
        name: 'parallax',
        version: spec.version,
        private: true,
        type: 'module',
        engines: { node: `>=${MIN_NODE}` },
      },
      null,
      2,
    )}\n`,
    'CHANGELOG.md': changelogUpTo(spec.version, spec.versions),
    LICENSE: await readFile(path.join(REPO_ROOT, 'LICENSE')),
    'THIRD_PARTY_NOTICES.md': `# Third-party notices\n\nTest package ${spec.version} (update E2E).\n`,
    [INSTALL_CMD]: installCmd(MIN_NODE),
    [ICON_FILE]: await readFile(path.join(REPO_ROOT, 'src', 'server', 'install', ICON_FILE)),
    ...packageRootFiles(MIN_NODE),
    ...spec.files,
  };
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split('/'));
    if (content === null) {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const walk = await walkPackage(dir);
  if (walk.problems.length > 0) throw new Error(`package ${dir} is not plain:\n${walk.problems.join('\n')}`);
  const release = releaseInfoSchema.parse({
    schemaVersion: RELEASE_SCHEMA_VERSION,
    name: 'parallax',
    version: spec.version,
    commit: createHash('sha1').update(spec.buildId).digest('hex'),
    buildId: spec.buildId,
    minNode: MIN_NODE,
    createdAt: new Date().toISOString(),
    schemas: storeSchemaHashes(),
    sdk: spec.sdk,
    files: await hashFiles(dir, walk.files),
  } satisfies ReleaseInfo);
  const bytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`, 'utf8');
  await writeFile(path.join(dir, RELEASE_FILE), bytes);
  await writeFile(
    path.join(dir, RELEASE_SIGNATURE_FILE),
    `${sign(null, bytes, spec.key.privateKey).toString('base64')}\n`,
  );
  let archived: { file: string; bytes: Buffer } | null = null;
  return {
    version: spec.version,
    dir,
    release,
    archive: async () => {
      if (archived !== null) return archived;
      const file = archivePath(out, spec.version);
      await rm(file, { force: true });
      archived = { file, bytes: await archiveFolders(out, [path.basename(dir)], file) };
      return archived;
    },
  };
}

/** First line of a server bundle as `checkBuild` reads it (scripts/build-server.ts banner). */
export function serverBanner(buildId: string): string {
  return `// Parallax server, build ${buildId}`;
}

/** `dist/web/build.json` (vite.config.ts `buildInfo`). */
export function webBuildInfo(buildId: string): string {
  return `${JSON.stringify({ buildId })}\n`;
}
