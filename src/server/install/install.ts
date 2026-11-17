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
 * 4. Root files (`start.mjs`, `parallax.cmd` from the version's `root\` or the own templates,
 *    `parallax.ico`; only when changed), `current.json` (`previous` = the version before), the
 *    Start menu shortcut, the cleanup (versions.ts).
 *
 * The parts are shared with the update (WP-87, docs/wp/WP-87.md §1.9): `stageVersion` = steps 1–3
 * without switching, `switchVersion`/`restoreCurrent` = the root files and current.json of step 4
 * and their way back, `verifyVersion` = the full check of an installed version folder.
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
import { comparePackageFiles, sha256File, walkPackage, type PackageFile } from '../launcher/packageFiles';
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
  CURRENT_FILE,
  DOWNLOADS_DIR,
  ICON_FILE,
  InstallError,
  PACKAGE_ROOT_DIR,
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
  type InstallErrorReason,
} from './layout';
import { SdkError } from './sdk';
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

const sdkPackageSchema = z.object({ name: z.string(), version: z.string() });

/**
 * The reason of a failed installation step (WP-87 maps it to an update error code):
 * `InstallError.reason`, `sdk` for an `SdkError` of the SDK step, else `io`.
 */
export function installErrorReason(error: unknown): InstallErrorReason {
  if (error instanceof InstallError) return error.reason;
  if (error instanceof SdkError) return 'sdk';
  return 'io';
}

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
    const missing = fsErrorCode(error) === 'ENOENT';
    throw new InstallError(
      missing
        ? `${file} is missing - is ${dir} an unpacked Parallax package?`
        : `${file} could not be read: ${toError(error).message}`,
      { cause: error, reason: missing ? 'files' : 'io' },
    );
  }
  let signature: string;
  try {
    signature = await readFile(path.join(dir, RELEASE_SIGNATURE_FILE), 'utf8');
  } catch (error) {
    throw new InstallError(
      `${RELEASE_SIGNATURE_FILE} is missing in ${dir} - only signed release packages can be installed`,
      { cause: error, reason: 'signature' },
    );
  }
  if (!verifyReleaseSignature(bytes, signature, keys)) {
    throw new InstallError(
      `${file}: invalid signature - the package was changed or is no Parallax release. ` +
        'Download it again from the Parallax releases on GitHub.',
      { reason: 'signature' },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new InstallError(`${file} is not valid JSON`, { cause: error, reason: 'files' });
  }
  const parsed = releaseInfoSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InstallError(`${file} is invalid: ${z.prettifyError(parsed.error)}`, { reason: 'files' });
  }
  return { release: parsed.data, bytes };
}

/** Throws unless `nodeVersion` is at least `release.minNode`. */
export function checkNodeVersion(release: ReleaseInfo, nodeVersion: string = process.versions.node): void {
  if ((compareVersions(nodeVersion, release.minNode) ?? -1) < 0) {
    throw new InstallError(
      `Parallax ${release.version} needs Node.js ${release.minNode} or newer, this is ${nodeVersion}. ` +
        'Update Node.js (https://nodejs.org/) and start the installation again.',
      { reason: 'node' },
    );
  }
}

interface FileProgress {
  signal?: AbortSignal | undefined;
  /** First with `done = 0`, then after each file. */
  onFile?: ((done: number, total: number) => void) | undefined;
}

/** `rel` → SHA-256 of every file (in list order; like packageFiles `hashFiles`, with progress). */
async function hashListed(
  dir: string,
  files: readonly PackageFile[],
  progress: FileProgress,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  progress.onFile?.(0, files.length);
  let done = 0;
  for (const file of files) {
    progress.signal?.throwIfAborted();
    out[file.rel] = await sha256File(path.join(dir, ...file.rel.split('/')));
    progress.onFile?.(++done, files.length);
  }
  return out;
}

/** Throws unless `dir` holds exactly the files of release.json (`skipSdk`: the SDK folder is ignored). */
async function checkFiles(
  dir: string,
  release: ReleaseInfo,
  what: string,
  skipSdk: boolean,
  progress: FileProgress = {},
): Promise<number> {
  const walk = await walkPackage(dir);
  const files = skipSdk
    ? walk.files.filter((file) => !file.rel.toLowerCase().startsWith(SDK_PREFIX))
    : walk.files;
  const problems = comparePackageFiles(
    { files, problems: walk.problems },
    await hashListed(dir, files, progress),
    release.files,
    [RELEASE_FILE, RELEASE_SIGNATURE_FILE],
  );
  if (problems.length > 0) {
    const shown = problems.slice(0, 20).join('\n  ');
    const more = problems.length > 20 ? `\n  ... and ${String(problems.length - 20)} more` : '';
    throw new InstallError(`${what} does not match release.json:\n  ${shown}${more}`, { reason: 'files' });
  }
  return Object.keys(release.files).length;
}

/** The files a copy of the package holds: the listed ones, release.json and its signature. */
function copiedFiles(release: ReleaseInfo): string[] {
  return [...Object.keys(release.files), RELEASE_FILE, RELEASE_SIGNATURE_FILE];
}

/**
 * Copies exactly the listed files (content only), a few at a time. The first failure stops every
 * worker; it is thrown once all of them have stopped (so the caller can remove the folder).
 */
async function copyListed(
  from: string,
  to: string,
  release: ReleaseInfo,
  progress: FileProgress,
): Promise<void> {
  const rels = copiedFiles(release);
  let next = 0;
  let done = 0;
  const state: { failure: Error | null } = { failure: null };
  const worker = async (): Promise<void> => {
    for (let index = next++; index < rels.length && state.failure === null; index = next++) {
      try {
        progress.signal?.throwIfAborted();
        const parts = (rels[index] ?? '').split('/');
        const target = path.join(to, ...parts);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, await readFile(path.join(from, ...parts)));
        progress.onFile?.(++done, rels.length);
      } catch (error) {
        state.failure ??= toError(error);
      }
    }
  };
  progress.onFile?.(0, rels.length);
  await Promise.all(Array.from({ length: COPY_CONCURRENCY }, worker));
  if (state.failure !== null) throw state.failure;
}

/** Throws (`sdk`) unless the Agent SDK in `dir` has the name and version of release.json. */
async function checkSdk(dir: string, release: ReleaseInfo): Promise<void> {
  const file = path.join(dir, 'node_modules', ...AGENT_SDK_PACKAGE.split('/'), 'package.json');
  let sdk: z.infer<typeof sdkPackageSchema>;
  try {
    sdk = sdkPackageSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    throw new InstallError(`The Agent SDK in ${dir} is missing or damaged (${file}).`, {
      cause: error,
      reason: 'sdk',
    });
  }
  if (sdk.name !== release.sdk.name || sdk.version !== release.sdk.version) {
    throw new InstallError(
      `The Agent SDK in ${dir} is ${sdk.name} ${sdk.version}, release.json names ${release.sdk.name} ` +
        `${release.sdk.version}.`,
      { reason: 'sdk' },
    );
  }
}

/** Is `dir` an intact installation of exactly this release (same release.json bytes, files, SDK)? */
async function isIntact(
  dir: string,
  bytes: Buffer,
  release: ReleaseInfo,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    if (!(await readFile(path.join(dir, RELEASE_FILE))).equals(bytes)) return false;
    await checkSdk(dir, release);
    await checkFiles(dir, release, dir, true, { signal });
    return true;
  } catch {
    signal?.throwIfAborted();
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
        { cause: error, reason: 'in_use' },
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

/** Content of `file`, or null when it (or its folder) does not exist; other failures throw. */
async function readIfThere(file: string): Promise<Buffer | null> {
  try {
    return await withFsRetry(() => readFile(file));
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new InstallError(`${file} could not be read: ${toError(error).message}`, { cause: error });
  }
}

/**
 * `root/start.mjs` and `root/parallax.cmd` of a package (`/`-separated path → content):
 * scripts/release-pack.ts writes them, so they are listed in release.json and signed (WP-87).
 */
export function packageRootFiles(minNode: string): Record<string, string> {
  return {
    [`${PACKAGE_ROOT_DIR}/${START_SCRIPT}`]: startScript(),
    [`${PACKAGE_ROOT_DIR}/${START_CMD}`]: startCmd(minNode),
  };
}

/**
 * start.mjs and parallax.cmd from `versions\<v>\root\` (each, when the package has it – else the
 * templates of this code) and parallax.ico (from the version folder, when it has one).
 */
export async function writeRootFiles(root: string, version: string, minNode: string): Promise<void> {
  const own = path.join(versionDir(root, version), PACKAGE_ROOT_DIR);
  await writeIfChanged(
    path.join(root, START_SCRIPT),
    (await readIfThere(path.join(own, START_SCRIPT))) ?? startScript(),
  );
  await writeIfChanged(
    path.join(root, START_CMD),
    (await readIfThere(path.join(own, START_CMD))) ?? startCmd(minNode),
  );
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

/** release.json of an installed version (not checked against a signature: see `verifyVersion`). */
async function readInstalledRelease(root: string, version: string): Promise<ReleaseInfo> {
  const file = path.join(versionDir(root, version), RELEASE_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new InstallError(`${file} could not be read: ${toError(error).message}`, {
      cause: error,
      reason: 'files',
    });
  }
  const parsed = releaseInfoSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InstallError(`${file} is invalid: ${z.prettifyError(parsed.error)}`, { reason: 'files' });
  }
  if (parsed.data.version !== version) {
    throw new InstallError(`${file} names version ${parsed.data.version}, not ${version}`, {
      reason: 'files',
    });
  }
  return parsed.data;
}

/** Root files and current.json for `version`. */
async function pointTo(root: string, version: string, previous: string | null): Promise<void> {
  const release = await readInstalledRelease(root, version);
  await writeRootFiles(root, version, release.minNode);
  await writeCurrent(root, { schemaVersion: 1, version, previous });
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

/** The steps of `stageVersion`, in this order: check the package, copy and check the copy, the SDK. */
export type StageStep = 'check' | 'copy' | 'sdk';

export interface StageOptions extends InstallOptions {
  /** Aborts between files and steps (throws the signal's reason); the staging folder is removed. */
  signal?: AbortSignal;
  /**
   * Progress per file (the caller throttles): `check` = files of the package hashed, `copy` = files
   * copied and then hashed again in the copy (total = twice the copied files), `sdk` = 0 or 1 of 1.
   * An intact version folder (`reused`) reports only `check`.
   */
  onProgress?: (step: StageStep, done: number, total: number) => void;
}

export interface StageResult {
  release: ReleaseInfo;
  /** The bytes of release.json (signed). */
  bytes: Buffer;
  /** `versions\<v>`. */
  dir: string;
  /** `versions\<v>` was intact and kept (nothing copied, no SDK step). */
  reused: boolean;
}

export type StageDeps = Pick<InstallDeps, 'provideSdk' | 'log' | 'now'>;

/**
 * Steps 1–3 without switching (docs/wp/WP-87.md §1.9): signature, Node version, the package's
 * files, copy into `versions\.staging-…`, check of the copy, the SDK, rename to `versions\<v>` – or
 * an intact `versions\<v>` is kept. current.json and the root files stay as they are.
 */
export async function stageVersion(options: StageOptions, deps: StageDeps): Promise<StageResult> {
  const now = deps.now ?? (() => new Date());
  const { root, signal } = options;
  const report = options.onProgress ?? (() => undefined);
  assertNotRealUserFolder(root);
  signal?.throwIfAborted();
  const { release, bytes } = await readSignedRelease(options.packageDir, options.keys);
  checkNodeVersion(release, options.nodeVersion);
  deps.log(`Installing Parallax ${release.version} into ${root} ...`);
  const count = await checkFiles(options.packageDir, release, options.packageDir, false, {
    signal,
    onFile: (done, total) => {
      report('check', done, total);
    },
  });
  deps.log(`Package checked: signature and ${String(count)} files.`);

  const versions = path.join(root, VERSIONS_DIR);
  await mkdir(versions, { recursive: true });
  const dir = versionDir(root, release.version);
  if (await isIntact(dir, bytes, release, signal)) {
    deps.log(`Parallax ${release.version} is already installed and intact - kept.`);
    return { release, bytes, dir, reused: true };
  }
  const staging = path.join(
    versions,
    `${STAGING_PREFIX}${release.version}-${folderStamp(now())}-${String(process.pid)}`,
  );
  const copies = copiedFiles(release).length;
  try {
    await copyListed(options.packageDir, staging, release, {
      signal,
      onFile: (done) => {
        report('copy', done, copies * 2);
      },
    });
    await checkFiles(staging, release, `The copy in ${staging}`, false, {
      signal,
      onFile: (done) => {
        report('copy', copies + Math.min(done, copies), copies * 2);
      },
    });
    signal?.throwIfAborted();
    report('sdk', 0, 1);
    const source = await deps.provideSdk({
      spec: release.sdk,
      target: path.join(staging, 'node_modules', ...AGENT_SDK_PACKAGE.split('/')),
      cacheDir: path.join(root, CACHE_DIR),
      tempDir: path.join(root, DOWNLOADS_DIR),
      ...(options.sdkTarball === undefined ? {} : { tarball: options.sdkTarball }),
      ...(options.registry === undefined ? {} : { registry: options.registry }),
    });
    deps.log(`Agent SDK ${release.sdk.version}: checked against release.json (${source}).`);
    report('sdk', 1, 1);
    signal?.throwIfAborted();
    await moveIntoPlace(staging, dir, now());
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
  return { release, bytes, dir, reused: false };
}

export interface SwitchOptions {
  /**
   * current.json `previous`. Default: the version current.json named before – or, when that is
   * `version` already, its `previous`.
   */
  previous?: string | null;
  /** Gets the note about a damaged current.json. */
  log: (line: string) => void;
}

export interface SwitchResult {
  previous: string | null;
  /** current.json before the switch (null: missing or damaged) – for `restoreCurrent`. */
  before: CurrentFile | null;
}

/**
 * Switches the root to the installed `version`: the root files (`writeRootFiles`) and current.json.
 * Nothing is checked beyond release.json of the version (`verifyVersion` does the full check).
 */
export async function switchVersion(
  root: string,
  version: string,
  options: SwitchOptions,
): Promise<SwitchResult> {
  assertNotRealUserFolder(root);
  const before = await currentOrNull(root, options.log);
  const previous =
    options.previous !== undefined
      ? options.previous
      : before === null
        ? null
        : before.version !== version
          ? before.version
          : before.previous;
  await pointTo(root, version, previous);
  return { previous, before };
}

/**
 * The way back of `switchVersion`: current.json as it was (written like the installer writes it,
 * so a file of the installer comes back byte for byte; `null` = there was none: it is deleted),
 * then the root files of that version. current.json first: it decides what start.mjs loads.
 */
export async function restoreCurrent(root: string, before: CurrentFile | null): Promise<void> {
  assertNotRealUserFolder(root);
  if (before === null) {
    await withFsRetry(() => rm(path.join(root, CURRENT_FILE), { force: true }));
    return;
  }
  await writeCurrent(root, before);
  const release = await readInstalledRelease(root, before.version);
  await writeRootFiles(root, before.version, release.minNode);
}

/**
 * Full check of `versions\<version>` (before switching to a prepared version, docs/wp/WP-87.md
 * §2.2): signature of its release.json with `keys`, its version, every listed file with its hash
 * (no file too many), name and version of the Agent SDK. Throws `InstallError` (`signature`,
 * `files`, `sdk`, `io`); returns the release.
 */
export async function verifyVersion(
  root: string,
  version: string,
  keys: readonly string[] = RELEASE_PUBLIC_KEYS,
): Promise<ReleaseInfo> {
  assertNotRealUserFolder(root);
  const dir = versionDir(root, version);
  const { release } = await readSignedRelease(dir, keys);
  if (release.version !== version) {
    throw new InstallError(`${dir}: release.json names version ${release.version}`, { reason: 'files' });
  }
  await checkSdk(dir, release);
  await checkFiles(dir, release, dir, true);
  return release;
}

export async function installPackage(options: InstallOptions, deps: InstallDeps): Promise<InstallResult> {
  const now = deps.now ?? (() => new Date());
  const root = options.root;
  const { release, reused } = await stageVersion(options, deps);
  const { previous } = await switchVersion(root, release.version, { log: deps.log });
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
      { reason: 'files' },
    );
  }
  const old = await currentOrNull(root, deps.log);
  const state = await runningState(root, version, deps);
  if (old?.version === version) {
    return { version, previous: old.previous, unchanged: true, runningOther: state.runningOther };
  }
  const previous = old?.version ?? null;
  await pointTo(root, version, previous);
  await deps.startMenu(root);
  return { version, previous, unchanged: false, runningOther: state.runningOther };
}
