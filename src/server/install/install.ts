/**
 * Installing a package into an installation root and switching versions (WP-86, docs/wp/WP-83.md
 * §8.3 and §7):
 *
 * 1. `release.json` of the package: Ed25519 signature (keys of THIS code – the installed version's
 *    after a hand-over), schema, Node version (`minNode`, with minor and patch).
 * 2. The unpacked package: only plain files (no links, junctions, hardlinks, data streams, names
 *    that differ only in case, non-ASCII names) and exactly the files of release.json with their
 *    SHA-256 – a foreign file aborts.
 * 3. Copy exactly the listed files into `versions\.staging-<v>-…` (content only: no data streams,
 *    no mark of the web) and check the copy again; the Agent SDK joins it (install/sdk.ts, checked
 *    against the signed `integrity`); then rename to `versions\<v>`. An intact `versions\<v>` (same
 *    release.json, every file, the SDK) is kept as is.
 * 4. Root files (`start.mjs`, `parallax.cmd`, `parallax.ico`; only when changed), `current.json`
 *    (`previous` = the version before), the Start menu shortcut, the cleanup (versions/ts).
 *
 * A running Parallax does not stop the installation: its version folder stays untouched (the
 * cleanup protects it) and the caller tells the user to restart.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { compareVersions } from '@shared/version';
import { toError } from '../lib/async';
import { withFsRetry, writeFileAtomic } from '../lib/fs';
import { fsErrorCode } from '../lib/paths';
import { comparePackageFiles, hashFiles, walkPackage } from '../launcher/packageFiles';
import {
  AGENT_SDK_PACKAGE,
  RELEASE_FILE,
  RELEASE_PUBLIC_KEYS,
  RELEASE_SIGNATURE_FILE,
  releaseInfoSchema,
  verifyReleaseSignature,
  type ReleaseInfo,
} from '../launcher/release';
import {
  CACHE_DIR,
  DOWNLOADS_DIR,
  ICON_FILE,
  InstallError,
  START_CMD,
  START_SCRIPT,
  STAGING_PREFIX,
  TRASH_PREFIX,
  VERSIONS_DIR,
  assertNotRealUserFolder,
  readCurrent,
  versionDir,
  writeCurrent,
  type CurrentFile,
} from './layout';
import { startCmd, startScript } from './templates';
import {
  cleanupVersions,
  folderStamp,
  listInstalledVersions,
  versionOfBuild,
  type CleanupResult,
} from './versions';

/** What the SDK step gets (install/sdk.ts `provideSdk` without its seams). */
export interface SdkRequest {
  spec: ReleaseInfo['sdk'];
  /** `<staging>\node_modules\@anthropic-ai\claude-agent-sdk` (missing). */
  target: string;
  cacheDir: string;
  tempDir: string;
  tarball?: string;
  registry?: string;
}

export interface InstallDeps {
  /** Puts the checked Agent SDK into `request.target`; resolves with where it came from. */
  provideSdk: (request: SdkRequest) => Promise<string>;
  /** Creates or refreshes the Start menu shortcut on `<root>\start.mjs`: null = done, else why not. */
  startMenu: (root: string) => Promise<string | null>;
  /** Build id of the server running on the data directory (lock file + health), or null. */
  runningBuildId: () => Promise<string | null>;
  /** One line for the user. */
  log: (line: string) => void;
  now?: () => Date;
}

export interface InstallOptions {
  /** The unpacked package (release.json, dist/, node_modules/ …). */
  packageDir: string;
  root: string;
  /** `--sdk-tarball`: the SDK from this file only (checked the same way). */
  sdkTarball?: string;
  /** `--registry`: the registry for the SDK download. */
  registry?: string;
  /** Test seam: release keys (default `RELEASE_PUBLIC_KEYS`). */
  keys?: readonly string[];
  /** Test seam (default `process.versions.node`). */
  nodeVersion?: string;
}

export interface InstallResult {
  version: string;
  previous: string | null;
  /** `versions\<v>` was intact and kept (nothing copied, no SDK step). */
  reused: boolean;
  /** Version of a running server, when it is not the installed one (restart needed). */
  runningOther: string | null;
  /** The server runs, but its build is no installed version (e.g. from a checkout). */
  runningForeign: boolean;
  cleanup: CleanupResult;
  /** Why the Start menu shortcut is missing, or null. */
  startMenuProblem: string | null;
}

const SDK_PREFIX = `node_modules/${AGENT_SDK_PACKAGE}/`.toLowerCase();
const COPY_CONCURRENCY = 16;

/** release.json + signature of `dir`, checked with `keys`. */
export async function readSignedRelease(
  dir: string,
  keys: readonly string[] = RELEASE_PUBLIC_KEYS,
): Promise<{ release: ReleaseInfo; bytes: Buffer }> {
  const file = path.join(dir, RELEASE_FILE);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    throw new InstallError(
      fsErrorCode(error) === 'ENOENT'
        ? `${file} is missing - is ${dir} an unpacked Parallax package?`
        : `${file} could not be read: ${toError(error).message}`,
      { cause: error },
    );
  }
  let signature: string;
  try {
    signature = await readFile(path.join(dir, RELEASE_SIGNATURE_FILE), 'utf8');
  } catch (error) {
    throw new InstallError(
      `${RELEASE_SIGNATURE_FILE} is missing in ${dir} - only signed release packages can be installed`,
      { cause: error },
    );
  }
  if (!verifyReleaseSignature(bytes, signature, keys)) {
    throw new InstallError(
      `${file}: invalid signature - the package was changed or is no Parallax release. ` +
        'Download it again from the Parallax releases on GitHub.',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new InstallError(`${file} is not valid JSON`, { cause: error });
  }
  const parsed = releaseInfoSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InstallError(`${file} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return { release: parsed.data, bytes };
}

/** Throws unless `nodeVersion` is at least `release.minNode`. */
export function checkNodeVersion(release: ReleaseInfo, nodeVersion: string = process.versions.node): void {
  if ((compareVersions(nodeVersion, release.minNode) ?? -1) < 0) {
    throw new InstallError(
      `Parallax ${release.version} needs Node.js ${release.minNode} or newer, this is ${nodeVersion}. ` +
        'Update Node.js (https://nodejs.org/) and start the installation again.',
    );
  }
}

/** Throws unless `dir` holds exactly the files of release.json (`skipSdk`: the SDK folder is ignored). */
async function checkFiles(
  dir: string,
  release: ReleaseInfo,
  what: string,
  skipSdk: boolean,
): Promise<number> {
  const walk = await walkPackage(dir);
  const files = skipSdk
    ? walk.files.filter((file) => !file.rel.toLowerCase().startsWith(SDK_PREFIX))
    : walk.files;
  const problems = comparePackageFiles(
    { files, problems: walk.problems },
    await hashFiles(dir, files),
    release.files,
    [RELEASE_FILE, RELEASE_SIGNATURE_FILE],
  );
  if (problems.length > 0) {
    const shown = problems.slice(0, 20).join('\n  ');
    const more = problems.length > 20 ? `\n  ... and ${String(problems.length - 20)} more` : '';
    throw new InstallError(`${what} does not match release.json:\n  ${shown}${more}`);
  }
  return Object.keys(release.files).length;
}

/** Copies exactly the listed files (content only), a few at a time. */
async function copyListed(from: string, to: string, release: ReleaseInfo): Promise<void> {
  const rels = [...Object.keys(release.files), RELEASE_FILE, RELEASE_SIGNATURE_FILE];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < rels.length; index = next++) {
      const parts = (rels[index] ?? '').split('/');
      const target = path.join(to, ...parts);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.join(from, ...parts)));
    }
  };
  await Promise.all(Array.from({ length: COPY_CONCURRENCY }, worker));
}

/** Is `dir` an intact installation of exactly this release (same release.json bytes, files, SDK)? */
async function isIntact(dir: string, bytes: Buffer, release: ReleaseInfo): Promise<boolean> {
  try {
    if (!(await readFile(path.join(dir, RELEASE_FILE))).equals(bytes)) return false;
    const sdk = z
      .object({ name: z.string(), version: z.string() })
      .parse(
        JSON.parse(
          await readFile(
            path.join(dir, 'node_modules', ...AGENT_SDK_PACKAGE.split('/'), 'package.json'),
            'utf8',
          ),
        ),
      );
    if (sdk.name !== release.sdk.name || sdk.version !== release.sdk.version) return false;
    await checkFiles(dir, release, dir, true);
    return true;
  } catch {
    return false;
  }
}

/** `staging` becomes `target`; an existing (damaged) `target` goes to the trash first. */
async function moveIntoPlace(staging: string, target: string, now: Date): Promise<void> {
  const trash = path.join(
    path.dirname(target),
    `${TRASH_PREFIX}${folderStamp(now)}-${path.basename(target)}`,
  );
  let trashed = false;
  try {
    await withFsRetry(() => rename(target, trash));
    trashed = true;
  } catch (error) {
    if (fsErrorCode(error) !== 'ENOENT') {
      throw new InstallError(
        `${target} is in use - stop Parallax ("Stop server" in the menu) and install again`,
        { cause: error },
      );
    }
  }
  await withFsRetry(() => rename(staging, target));
  if (trashed) await rm(trash, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}

/** Writes `file` only when its content differs (atomic). */
async function writeIfChanged(file: string, data: Buffer | string): Promise<void> {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  try {
    if ((await readFile(file)).equals(bytes)) return;
  } catch {
    // missing: write it
  }
  await writeFileAtomic(file, bytes);
}

/** start.mjs, parallax.cmd and parallax.ico (from the version folder, when it has one). */
export async function writeRootFiles(root: string, version: string, minNode: string): Promise<void> {
  await writeIfChanged(path.join(root, START_SCRIPT), startScript());
  await writeIfChanged(path.join(root, START_CMD), startCmd(minNode));
  let icon: Buffer | null = null;
  try {
    icon = await readFile(path.join(versionDir(root, version), ICON_FILE));
  } catch {
    // a package without an icon: the shortcut shows node's
  }
  if (icon !== null) await writeIfChanged(path.join(root, ICON_FILE), icon);
}

/** current.json, or null when it is missing or damaged (logged). */
async function currentOrNull(root: string, log: (line: string) => void): Promise<CurrentFile | null> {
  try {
    return await readCurrent(root);
  } catch (error) {
    log(`Note: ${toError(error).message} - it is written again.`);
    return null;
  }
}

/** The running server's version among the installed ones (see InstallResult). */
async function runningState(
  root: string,
  installedVersion: string,
  deps: InstallDeps,
): Promise<{ running: string | null; runningOther: string | null; runningForeign: boolean }> {
  const buildId = await deps.runningBuildId();
  const running = versionOfBuild(await listInstalledVersions(root), buildId);
  return {
    running,
    runningOther: running !== null && running !== installedVersion ? running : null,
    runningForeign: buildId !== null && running === null,
  };
}

export async function installPackage(options: InstallOptions, deps: InstallDeps): Promise<InstallResult> {
  const now = deps.now ?? (() => new Date());
  const root = options.root;
  assertNotRealUserFolder(root);
  const { release, bytes } = await readSignedRelease(options.packageDir, options.keys);
  checkNodeVersion(release, options.nodeVersion);
  deps.log(`Installing Parallax ${release.version} into ${root} ...`);
  const count = await checkFiles(options.packageDir, release, options.packageDir, false);
  deps.log(`Package checked: signature and ${String(count)} files.`);

  const versions = path.join(root, VERSIONS_DIR);
  await mkdir(versions, { recursive: true });
  const target = versionDir(root, release.version);
  const reused = await isIntact(target, bytes, release);
  if (reused) {
    deps.log(`Parallax ${release.version} is already installed and intact - kept.`);
  } else {
    const staging = path.join(
      versions,
      `${STAGING_PREFIX}${release.version}-${folderStamp(now())}-${String(process.pid)}`,
    );
    try {
      await copyListed(options.packageDir, staging, release);
      await checkFiles(staging, release, `The copy in ${staging}`, false);
      const source = await deps.provideSdk({
        spec: release.sdk,
        target: path.join(staging, 'node_modules', ...AGENT_SDK_PACKAGE.split('/')),
        cacheDir: path.join(root, CACHE_DIR),
        tempDir: path.join(root, DOWNLOADS_DIR),
        ...(options.sdkTarball === undefined ? {} : { tarball: options.sdkTarball }),
        ...(options.registry === undefined ? {} : { registry: options.registry }),
      });
      deps.log(`Agent SDK ${release.sdk.version}: checked against release.json (${source}).`);
      await moveIntoPlace(staging, target, now());
    } finally {
      await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  }

  const old = await currentOrNull(root, deps.log);
  const previous = old === null ? null : old.version !== release.version ? old.version : old.previous;
  await writeRootFiles(root, release.version, release.minNode);
  await writeCurrent(root, { schemaVersion: 1, version: release.version, previous });
  const startMenuProblem = await deps.startMenu(root);
  const state = await runningState(root, release.version, deps);
  const cleanup = await cleanupVersions(root, [release.version, previous, state.running], now());
  return {
    version: release.version,
    previous,
    reused,
    runningOther: state.runningOther,
    runningForeign: state.runningForeign,
    cleanup,
    startMenuProblem,
  };
}

export interface UseResult {
  version: string;
  previous: string | null;
  /** It was the current version already. */
  unchanged: boolean;
  runningOther: string | null;
}

/**
 * `--use <version>`: switches current.json to an installed version (its release.json and SDK must
 * be there; the files were checked when it was installed).
 */
export async function useVersion(root: string, version: string, deps: InstallDeps): Promise<UseResult> {
  assertNotRealUserFolder(root);
  const installed = await listInstalledVersions(root);
  const entry = installed.find((item) => item.version === version && item.buildId !== null);
  const sdkPackage = path.join(
    versionDir(root, version),
    'node_modules',
    ...AGENT_SDK_PACKAGE.split('/'),
    'package.json',
  );
  let sdkThere = true;
  try {
    await readFile(sdkPackage);
  } catch {
    sdkThere = false;
  }
  if (entry === undefined || !sdkThere) {
    const list = installed.map((item) => item.version).join(', ') || 'none';
    throw new InstallError(
      `Parallax ${version} is not installed (completely) in ${root}. Installed: ${list}.`,
    );
  }
  const old = await currentOrNull(root, deps.log);
  const state = await runningState(root, version, deps);
  if (old?.version === version) {
    return { version, previous: old.previous, unchanged: true, runningOther: state.runningOther };
  }
  const release = releaseInfoSchema.parse(
    JSON.parse(await readFile(path.join(versionDir(root, version), RELEASE_FILE), 'utf8')),
  );
  await writeRootFiles(root, version, release.minNode);
  const previous = old?.version ?? null;
  await writeCurrent(root, { schemaVersion: 1, version, previous });
  await deps.startMenu(root);
  return { version, previous, unchanged: false, runningOther: state.runningOther };
}
