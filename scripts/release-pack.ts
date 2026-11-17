/**
 * Stages a release package (WP-85, docs/wp/WP-83.md §5): `<out>/parallax-<version>/` with `dist/`
 * (server, launcher, installer), `install.cmd` and `parallax.ico` (WP-86), the flat server runtime in `node_modules` WITHOUT the Agent SDK, a shortened `package.json`,
 * `CHANGELOG.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md` and the unsigned `release.json`. Signing and
 * zipping happen in a separate CI job (`scripts/release/sign.ts`).
 *
 *   pnpm exec tsx --tsconfig tsconfig.tools.json scripts/release-pack.ts --out <folder> [--allow-dirty]
 *
 * Needs a finished `pnpm build` of the same commit and network access (pnpm install --prod). A heavy
 * run (ADR-154): not part of the tests; CI runs it in the build job.
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { windowsPathIssue, isWindowsPathInside } from '@shared/paths';
import { readBundleBuildId, readWebBundleBuildId, SERVER_BUNDLE } from '../src/server/launcher/build';
import {
  AGENT_SDK_PACKAGE,
  RELEASE_FILE,
  RELEASE_SCHEMA_VERSION,
  RELEASE_SIGNATURE_FILE,
  releaseInfoSchema,
  type ReleaseInfo,
} from '../src/server/launcher/release';
import { hashFiles, walkPackage } from '../src/server/launcher/packageFiles';
import { ICON_FILE, INSTALL_CMD, INSTALLER_BUNDLE, LAUNCHER_BUNDLE } from '../src/server/install/layout';
import { installCmd } from '../src/server/install/templates';
import { runFile } from '../src/server/lib/process';
import { resolveExecutable } from '../src/server/lib/windows';
import { storeSchemaHashes } from '../src/server/store/schemas';
import { isPrunable, isPrunableFolder } from './release/files';
import {
  collectBareImports,
  DYNAMIC_IMPORTS,
  optionalReason,
  packageOfSpecifier,
  resolverSource,
} from './release/imports';
import { lockedPackage } from './release/lockfile';
import {
  findPackageDirs,
  isAllowedLicense,
  packageRootsOfSourceMap,
  readLicenseTexts,
  readPackageInfo,
  renderNotices,
  WEB_ASSET_PACKAGES,
  type PackageInfo,
} from './release/notices';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_TIMEOUT_MS = 10 * 60_000;

function log(line: string): void {
  process.stdout.write(`[release-pack] ${line}\n`);
}

class PackError extends Error {}

const argsSchema = z.object({ out: z.string().min(1), allowDirty: z.boolean() });

function parseArgs(argv: readonly string[]): z.infer<typeof argsSchema> {
  let out: string | undefined;
  let allowDirty = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--allow-dirty') allowDirty = true;
    else if (arg === '--out') out = argv[++i];
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    else
      throw new PackError(`unknown argument ${arg}\nusage: release-pack.ts --out <folder> [--allow-dirty]`);
  }
  return argsSchema.parse({ out, allowDirty });
}

const packageJsonSchema = z.looseObject({
  name: z.literal('parallax'),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u),
  engines: z.object({ node: z.string().regex(/^>=\d+(?:\.\d+){0,2}$/u) }),
});

/** `>=24.5` → `24.5.0`. */
function minNodeOf(range: string): string {
  const parts = range.slice(2).split('.');
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

/** Environment for the nested pnpm: without the npm_* variables of the calling `pnpm exec`. */
function childEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !/^npm_/iu.test(entry[0]),
    ),
  );
}

/**
 * pnpm of the calling `pnpm exec` (npm_execpath): `pnpm.exe` directly, a `.cjs` entry through node;
 * otherwise the absolute `pnpm.exe` from the PATH (pnpm 12 ships a native executable).
 */
async function pnpmCommand(): Promise<{ file: string; prefix: string[] }> {
  const execPath = process.env.npm_execpath ?? '';
  if (/\.exe$/iu.test(execPath)) return { file: execPath, prefix: [] };
  if (/\.[cm]?js$/iu.test(execPath)) return { file: process.execPath, prefix: [execPath] };
  const exe = await resolveExecutable('pnpm', process.env);
  if (exe === null) throw new PackError('pnpm not found: run release-pack through pnpm (pnpm exec tsx …)');
  return { file: exe, prefix: [] };
}

async function run(file: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await runFile(file, args, {
    cwd,
    env: childEnv(),
    timeoutMs: INSTALL_TIMEOUT_MS,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new PackError(
      `${path.basename(file)} ${args.join(' ')} failed (${result.timedOut ? 'timeout' : `exit ${String(result.exitCode)}`}):\n` +
        `${result.stdout}\n${result.stderr}`.trim(),
    );
  }
  return result.stdout;
}

async function gitCommit(): Promise<string> {
  const git = await resolveExecutable('git', process.env);
  if (git === null) throw new PackError('git.exe not found on the PATH');
  return (await run(git, ['rev-parse', 'HEAD'], repoRoot)).trim();
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

/** Every bare import of the bundles and the Agent SDK must resolve in the staged node_modules. */
async function guardImports(stage: string): Promise<void> {
  const sdkDir = path.join(stage, 'node_modules', ...AGENT_SDK_PACKAGE.split('/'));
  const sdkFiles = (await readdir(sdkDir, { recursive: true, withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(?:m|c)?js$/u.test(entry.name) &&
        !entry.parentPath.includes('node_modules' + path.sep + '.bin'),
    )
    .map((entry) => path.relative(stage, path.join(entry.parentPath, entry.name)));
  const entries = [SERVER_BUNDLE, LAUNCHER_BUNDLE, ...sdkFiles];
  const found = await collectBareImports(entries, stage);
  for (const specifier of DYNAMIC_IMPORTS)
    found.set(specifier, ['(dynamic import, scripts/release/imports.ts)']);
  const required = [...found.keys()].filter((specifier) => optionalReason(specifier) === null).sort();
  const skipped = [...found.keys()].filter((specifier) => optionalReason(specifier) !== null).sort();
  const checker = path.join(stage, '.import-check.mjs');
  await writeFile(checker, resolverSource(required));
  let missing: [string, string][];
  try {
    missing = z
      .array(z.tuple([z.string(), z.string()]))
      .parse(JSON.parse(await run(process.execPath, [checker], stage)));
  } finally {
    await rm(checker, { force: true });
  }
  if (missing.length > 0) {
    throw new PackError(
      'imports that do not resolve in the package:\n' +
        missing
          .map(
            ([specifier, code]) => `  ${specifier} (${code}) from ${(found.get(specifier) ?? []).join(', ')}`,
          )
          .join('\n'),
    );
  }
  log(
    `import guard: ${String(required.length)} bare imports resolve (${[...new Set(required.map(packageOfSpecifier))].length} packages)` +
      (skipped.length > 0 ? `; skipped by design: ${skipped.join(', ')}` : ''),
  );
}

/** pnpm's bookkeeping (`.modules.yaml`, `.bin`) and files no runtime reads (isPrunable). */
async function cleanNodeModules(nodeModules: string): Promise<number> {
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.'))
      await rm(path.join(nodeModules, entry.name), { recursive: true, force: true });
  }
  let pruned = 0;
  // Test suites, CI setup, benchmarks in each package root (isPrunableFolder).
  for (const dir of await findPackageDirs(nodeModules)) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isPrunableFolder(entry.name)) continue;
      const folder = path.join(dir, entry.name);
      pruned += (await readdir(folder, { recursive: true, withFileTypes: true })).filter((e) =>
        e.isFile(),
      ).length;
      await rm(folder, { recursive: true, force: true });
    }
  }
  for (const entry of await readdir(nodeModules, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    if (entry.isDirectory() && entry.name === '.bin') {
      await rm(full, { recursive: true, force: true });
    } else if (entry.isFile() && isPrunable(entry.name)) {
      await rm(full, { force: true });
      pruned++;
    }
  }
  return pruned;
}

async function collectNotices(stage: string, version: string, sdkVersion: string): Promise<string> {
  const byKey = new Map<string, PackageInfo>();
  const add = (info: PackageInfo): void => {
    const key = `${info.name}@${info.version}`;
    const known = byKey.get(key);
    if (known === undefined) byKey.set(key, info);
    else for (const part of info.parts) known.parts.add(part);
  };
  for (const dir of await findPackageDirs(path.join(stage, 'node_modules')))
    add(await readPackageInfo(dir, 'server'));

  const assets = path.join(repoRoot, 'dist', 'web', 'assets');
  const webRoots = new Set<string>();
  for (const name of (await readdir(assets)).filter((file) => file.endsWith('.map'))) {
    const mapFile = path.join(assets, name);
    for (const root of packageRootsOfSourceMap(mapFile, await readFile(mapFile, 'utf8'))) webRoots.add(root);
  }
  for (const name of WEB_ASSET_PACKAGES)
    webRoots.add(path.join(repoRoot, 'node_modules', ...name.split('/')));
  for (const root of webRoots) add(await readPackageInfo(root, 'web'));

  const packages = [];
  const refused: string[] = [];
  for (const info of byKey.values()) {
    if (!isAllowedLicense(info.license)) refused.push(`${info.name}@${info.version} (${info.license})`);
    packages.push({ ...info, texts: await readLicenseTexts(info.dir) });
  }
  if (refused.length > 0)
    throw new PackError(
      `licenses outside the allowlist (scripts/release/notices.ts):\n  ${refused.join('\n  ')}`,
    );
  const sdkLicense = path.join(repoRoot, 'node_modules', ...AGENT_SDK_PACKAGE.split('/'), 'LICENSE.md');
  const licenseText = await readFile(sdkLicense, 'utf8').then(
    (text) => text.trim(),
    () => null,
  );
  log(`notices: ${String(packages.length)} packages`);
  return renderNotices({ version, packages, sdk: { version: sdkVersion, licenseText } });
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const outRoot = path.resolve(args.out);
  if (windowsPathIssue(outRoot) !== null)
    throw new PackError(`--out must be a plain local folder: ${outRoot}`);
  if (isWindowsPathInside(outRoot, repoRoot) || outRoot.toLowerCase() === repoRoot.toLowerCase()) {
    throw new PackError(
      '--out must be outside the repo (lint, tests and the public check would see the package)',
    );
  }

  const pkg = packageJsonSchema.parse(
    JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')),
  );
  const buildId = await readBundleBuildId(repoRoot);
  const firstLine = async (file: string): Promise<string> =>
    (await readFile(path.join(repoRoot, file), 'utf8')).split(/\r?\n/u, 1)[0] ?? '';
  if (buildId === null) throw new PackError('dist/server.js is missing - run pnpm build first');
  if (
    !(await firstLine(LAUNCHER_BUNDLE)).endsWith(` launcher, build ${buildId}`) ||
    !(await firstLine(INSTALLER_BUNDLE)).endsWith(` installer, build ${buildId}`) ||
    (await readWebBundleBuildId(repoRoot)) !== buildId
  ) {
    throw new PackError('dist/ is from different builds - run pnpm build again');
  }
  if (!buildId.startsWith(`${pkg.version}+`))
    throw new PackError(`build ${buildId} is not of version ${pkg.version}`);
  if (buildId.includes('.dirty') && !args.allowDirty) {
    throw new PackError(`build ${buildId} has uncommitted changes (--allow-dirty for a local trial only)`);
  }
  const commit = await gitCommit();
  const lockText = await readFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  const sdk = lockedPackage(lockText, AGENT_SDK_PACKAGE);

  const stage = path.join(outRoot, `parallax-${pkg.version}`);
  if (!(await isEmptyOrMissing(stage))) throw new PackError(`${stage} is not empty`);
  await mkdir(stage, { recursive: true });
  log(`staging ${pkg.version} (build ${buildId}) in ${stage}`);

  // 1. Server runtime, flat (no junctions), copied (no hardlinks into the pnpm store).
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await cp(path.join(repoRoot, file), path.join(stage, file));
  }
  const pnpm = await pnpmCommand();
  await run(
    pnpm.file,
    [
      ...pnpm.prefix,
      'install',
      '--prod',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--config.node-linker=hoisted',
      '--config.package-import-method=copy',
      '--config.confirm-modules-purge=false',
    ],
    stage,
  );
  log('pnpm install --prod done');

  // 2. dist/ (without dot files), then the import guard while the SDK is still there.
  await cp(path.join(repoRoot, 'dist'), path.join(stage, 'dist'), {
    recursive: true,
    filter: (source) => !path.basename(source).startsWith('.'),
  });
  await guardImports(stage);

  // 3. The SDK leaves (proprietary, fetched at install time); pnpm's bookkeeping too.
  await rm(path.join(stage, 'node_modules', ...AGENT_SDK_PACKAGE.split('/')), {
    recursive: true,
    force: true,
  });
  const pruned = await cleanNodeModules(path.join(stage, 'node_modules'));
  log(`node_modules: ${String(pruned)} files without runtime use removed (types, source maps, docs, tests)`);
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    await rm(path.join(stage, file));

  // 4. Package files.
  const minNode = minNodeOf(pkg.engines.node);
  await writeFile(
    path.join(stage, 'package.json'),
    `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', engines: { node: pkg.engines.node } }, null, 2)}\n`,
  );
  for (const file of ['CHANGELOG.md', 'LICENSE']) await cp(path.join(repoRoot, file), path.join(stage, file));
  // WP-86: the installer file (Explorer double click) and the icon of the Start menu shortcut.
  await writeFile(path.join(stage, INSTALL_CMD), installCmd(minNode));
  await cp(path.join(repoRoot, 'src', 'server', 'install', ICON_FILE), path.join(stage, ICON_FILE));
  await writeFile(
    path.join(stage, 'THIRD_PARTY_NOTICES.md'),
    await collectNotices(stage, pkg.version, sdk.version),
  );

  // 5. Only plain files, then release.json over all of them.
  const walk = await walkPackage(stage);
  const own = walk.files.filter((file) => file.rel === RELEASE_FILE || file.rel === RELEASE_SIGNATURE_FILE);
  if (walk.problems.length > 0 || own.length > 0) {
    throw new PackError(
      `the package is not plain:\n  ${[...walk.problems, ...own.map((f) => `${f.rel}: must not exist yet`)].join('\n  ')}`,
    );
  }
  const release: ReleaseInfo = releaseInfoSchema.parse({
    schemaVersion: RELEASE_SCHEMA_VERSION,
    name: pkg.name,
    version: pkg.version,
    commit,
    buildId,
    minNode,
    createdAt: new Date().toISOString(),
    schemas: storeSchemaHashes(),
    sdk: { name: AGENT_SDK_PACKAGE, version: sdk.version, integrity: sdk.integrity },
    files: await hashFiles(stage, walk.files),
  } satisfies ReleaseInfo);
  await writeFile(path.join(stage, RELEASE_FILE), `${JSON.stringify(release, null, 2)}\n`);
  const bytes = walk.files.reduce((sum, file) => sum + file.size, 0);
  log(
    `done: ${String(walk.files.length)} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, SDK ${sdk.version} excluded`,
  );
  log(
    `release.json: ${(await stat(path.join(stage, RELEASE_FILE))).size} bytes - sign it in CI (scripts/release/sign.ts)`,
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`[release-pack] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof PackError || error instanceof z.ZodError ? 1 : 2;
});
