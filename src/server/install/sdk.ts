/**
 * The Agent SDK of an installed version (WP-86 §2, docs/wp/WP-83.md §8.2). The SDK is proprietary
 * and not in the release zip: the installer puts exactly the version of `release.json` `sdk` into
 * `<version>\node_modules\@anthropic-ai\claude-agent-sdk`, checked against its signed `integrity`.
 *
 * Order (the first source that yields a file wins; every file goes through the same check):
 * 1. cache `<cacheDir>\<name without @, / → ->-<version>.tgz` (checked again; damaged → removed);
 * 2. `--sdk-tarball <file>` (no fallback: a wrong hash is an error);
 * 3. npm next to Node (`npm-cli.js pack`; npm evaluates the whole npm configuration);
 * 4. own download: registry from `--registry` / `NPM_CONFIG_REGISTRY` / `.npmrc` / registry.npmjs.org,
 *    tarball URL from the package metadata, auth from `.npmrc` for exactly that host; https only
 *    (http only for loopback), size limit, timeout, redirects followed by hand (auth per hop).
 *
 * The check: SHA-512 = `integrity`, else `SdkError` (a fetched file is deleted, the user's own
 * `--sdk-tarball` stays). The checked bytes are copied into the cache (temp file + rename) and the
 * cache file is unpacked with `System32\tar.exe --strip-components=1`; afterwards `package.json`
 * must carry the spec's name and version.
 *
 * Linux (WP-108): npm of the official Node build lives in `<prefix>/lib/node_modules/npm` (node is
 * `<prefix>/bin/node`), the archive is unpacked with `/usr/bin/tar` (GNU tar; `--no-same-owner
 * --no-same-permissions`, also when run as root in a container), paths follow the POSIX rules.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { toError } from '../lib/async';
import { withFsRetry } from '../lib/fs';
import { logger } from '../lib/logger';
import { fsErrorCode } from '../lib/paths';
import { runFile, systemTool, type RunFileFn, type RunFileResult } from '../lib/process';
import { installPathRules } from './layout';
import { authFor, readNpmrc, registryFor, type Npmrc } from './npmrc';

/** `release.json` `sdk`. */
export interface SdkSpec {
  name: string;
  version: string;
  integrity: string;
}

export interface ProvideSdkOptions {
  spec: SdkSpec;
  /** `<version folder>\node_modules\@anthropic-ai\claude-agent-sdk` – missing or empty. */
  target: string;
  /** `<root>\cache` */
  cacheDir: string;
  /** `<root>\downloads` (a fresh sub folder per attempt, removed afterwards). */
  tempDir: string;
  /** `--sdk-tarball <file>` */
  tarball?: string;
  /** `--registry <url>` */
  registry?: string;
  /** Default `process.execPath`; npm is looked up next to it (`npmCliPath`). */
  nodeExe?: string;
  /** Default `process.env` (npm configuration, `.npmrc`, registry variables). */
  env?: NodeJS.ProcessEnv;
  /** Default `runFile` (npm and tar: `tarTool()`). */
  run?: RunFileFn;
  fetch?: typeof fetch;
  /** Progress lines for the user (English); default: the server log. */
  log?: (line: string) => void;
}

export type SdkSource = 'cache' | 'tarball' | 'npm' | 'download';

/** Every failure of `provideSdk`; the message is meant for the user. */
export class SdkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SdkError';
  }
}

/** Largest SDK tarball the own download accepts. */
export const SDK_MAX_BYTES = 200 * 1024 * 1024;
/** Largest package metadata document (all versions of the package). */
export const SDK_METADATA_MAX_BYTES = 64 * 1024 * 1024;
export const NPM_TIMEOUT_MS = 5 * 60_000;
export const TAR_TIMEOUT_MS = 5 * 60_000;
/** Per request of the own download, including the body. */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);
const OUTPUT_TAIL_CHARS = 600;

const sdkSpecSchema = z.object({
  name: z
    .string()
    .max(214)
    .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u),
  version: z
    .string()
    .max(100)
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  /** One SHA-512 (64 bytes = 86 base64 characters + `==`). */
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u),
});

/** `npm pack --json`: one entry per packed spec (unknown fields are ignored). */
const npmPackSchema = z.array(z.object({ filename: z.string().min(1) })).min(1);

const packageMetadataSchema = z.object({ versions: z.record(z.string(), z.unknown()) });
const versionMetadataSchema = z.object({ dist: z.object({ tarball: z.string().min(1) }) });
const packageJsonSchema = z.object({ name: z.string(), version: z.string() });

type Env = Readonly<Record<string, string | undefined>>;

interface Context {
  spec: SdkSpec;
  /** `<name>@<version>` */
  label: string;
  target: string;
  cacheDir: string;
  cacheFile: string;
  tempDir: string;
  env: Env;
  childEnv: Record<string, string>;
  run: RunFileFn;
  fetch: typeof fetch;
  log: (line: string) => void;
}

/** A failed attempt of the own download (reported in the final message, never logged with secrets). */
class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

const moduleLog = logger.child({ module: 'install/sdk' });

/** File name of a packed npm package, as `npm pack` writes it: `@scope/name` → `scope-name-<version>.tgz`. */
export function sdkCacheFileName(spec: Pick<SdkSpec, 'name' | 'version'>): string {
  return `${spec.name.replace(/^@/u, '').replace('/', '-')}-${spec.version}.tgz`;
}

/** `sha512-<base64>` of a file (streamed). */
export function sha512Integrity(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => {
        resolve(`sha512-${hash.digest('base64')}`);
      });
  });
}

/** URL for messages and logs: no user info, no query (signed CDN links), no fragment. */
function safeUrl(url: URL | string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '(invalid URL)';
  }
}

/** Only `https:`; `http:` only for 127.0.0.1/localhost (a local test registry). */
export function isAllowedDownloadUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

function assertAllowedUrl(url: URL): void {
  if (!isAllowedDownloadUrl(url)) {
    throw new DownloadError(
      `${safeUrl(url)} refused: only https: is allowed (http: only for 127.0.0.1/localhost)`,
    );
  }
}

function errorText(error: unknown): string {
  const err = toError(error);
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out';
  const cause: unknown = err.cause;
  return cause instanceof Error && cause.message !== '' ? `${err.message} (${cause.message})` : err.message;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL_CHARS ? `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed;
}

function runFailure(result: RunFileResult, timeoutMs: number): string | null {
  if (result.timedOut) return `timed out after ${String(Math.round(timeoutMs / 60_000))} min`;
  if (result.exitCode === 0) return null;
  const output = tail(result.stderr) || tail(result.stdout);
  const code = result.exitCode === null ? `signal ${result.signal ?? '?'}` : `exit ${result.exitCode}`;
  return output === '' ? code : `${code}: ${output}`;
}

function assertUsablePath(label: string, file: string): void {
  const issue = installPathRules().issue(file);
  if (issue !== null) throw new SdkError(`${label} path refused (${issue}): ${file}`);
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function removeQuietly(target: string, ctx: Context): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    ctx.log(`could not remove ${target}: ${errorText(error)}`);
  }
}

function tarballHint(ctx: Context): string {
  return (
    `Download ${ctx.label} yourself (for example "npm pack ${ctx.label}" on a computer with access ` +
    `to the registry) and pass it with --sdk-tarball <file>; it is checked against the same integrity.`
  );
}

async function assertTargetEmpty(target: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(target);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return;
    throw new SdkError(`cannot read the target folder ${target}: ${errorText(error)}`);
  }
  if (names.length > 0) throw new SdkError(`the target folder is not empty: ${target}`);
}

// ---- 1. cache ----

async function fromCache(ctx: Context): Promise<boolean> {
  let actual: string;
  try {
    actual = await sha512Integrity(ctx.cacheFile);
  } catch (error) {
    if (fsErrorCode(error) !== 'ENOENT')
      ctx.log(`cache: ${ctx.cacheFile} unreadable (${errorText(error)}), ignored`);
    return false;
  }
  if (actual === ctx.spec.integrity) return true;
  ctx.log(`cache: ${path.basename(ctx.cacheFile)} does not match the expected integrity, removed`);
  await removeQuietly(ctx.cacheFile, ctx);
  return false;
}

let tmpCounter = 0;

/**
 * Copies `source` to a temp file in the cache, checks its SHA-512 there (the bytes that are
 * unpacked are the bytes that were checked) and renames it to the cache file.
 */
async function storeInCache(
  ctx: Context,
  source: string,
  what: string,
  removeSource: boolean,
): Promise<void> {
  await mkdir(ctx.cacheDir, { recursive: true });
  tmpCounter += 1;
  const tmp = `${ctx.cacheFile}.${String(process.pid)}.${String(tmpCounter)}.tmp`;
  try {
    try {
      await copyFile(source, tmp);
    } catch (error) {
      throw new SdkError(`${what}: cannot read ${source}: ${errorText(error)}`);
    }
    const actual = await sha512Integrity(tmp);
    if (actual !== ctx.spec.integrity) {
      if (removeSource) await removeQuietly(source, ctx);
      throw new SdkError(
        `${what}: the SHA-512 of the tarball does not match ${ctx.label} ` +
          `(expected ${ctx.spec.integrity}, got ${actual}). ${tarballHint(ctx)}`,
      );
    }
    await withFsRetry(() => rename(tmp, ctx.cacheFile));
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

// ---- unpack ----

/** The archiver: `System32\tar.exe` (bsdtar) on Windows, `/usr/bin/tar` or `/bin/tar` elsewhere. */
export function tarTool(platform: NodeJS.Platform = process.platform): string {
  return systemTool(platform === 'win32' ? 'tar.exe' : 'tar', process.env, platform);
}

/** Unpack arguments; GNU tar keeps owner and mode of the archive for root unless told otherwise. */
export function unpackArgs(
  archive: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const args = ['-x', '-z', '-f', archive, '--strip-components=1', '-C', target];
  if (platform !== 'win32') args.push('--no-same-owner', '--no-same-permissions');
  return args;
}

async function unpack(ctx: Context): Promise<void> {
  await mkdir(ctx.target, { recursive: true });
  const args = unpackArgs(ctx.cacheFile, ctx.target);
  const tar = tarTool();
  let problem: string | null;
  try {
    const result = await ctx.run(tar, args, {
      cwd: ctx.target,
      env: ctx.childEnv,
      timeoutMs: TAR_TIMEOUT_MS,
    });
    problem = runFailure(result, TAR_TIMEOUT_MS);
  } catch (error) {
    problem = `${path.basename(tar)} could not be started: ${errorText(error)}`;
  }
  problem ??= await checkUnpacked(ctx);
  if (problem !== null) {
    await removeQuietly(ctx.target, ctx);
    throw new SdkError(`unpacking ${path.basename(ctx.cacheFile)} failed: ${problem}`);
  }
}

async function checkUnpacked(ctx: Context): Promise<string | null> {
  const file = path.join(ctx.target, 'package.json');
  let parsed: z.infer<typeof packageJsonSchema>;
  try {
    const result = packageJsonSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (!result.success) return 'package.json has no name/version';
    parsed = result.data;
  } catch (error) {
    return `package.json unreadable (${errorText(error)})`;
  }
  if (parsed.name !== ctx.spec.name || parsed.version !== ctx.spec.version) {
    return `package.json is ${parsed.name}@${parsed.version}, expected ${ctx.label}`;
  }
  return null;
}

// ---- 3. npm next to node ----

/** File name from `npm pack --json` (stdout may carry other lines around the JSON array). */
export function packedFileName(stdout: string): string | null {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end < start) return null;
  let json: unknown;
  try {
    json = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = npmPackSchema.safeParse(json);
  if (!parsed.success) return null;
  const [first] = parsed.data;
  if (first === undefined) return null;
  // Both separators on every platform: the name must stay a plain file name in the work folder.
  const name = path.win32.basename(first.filename);
  return name.toLowerCase().endsWith('.tgz') ? name : null;
}

interface Fetched {
  file: string;
  workDir: string;
}

/**
 * npm of a Node installation: `<node folder>\node_modules\npm\bin\npm-cli.js` on Windows,
 * `<prefix>/lib/node_modules/npm/bin/npm-cli.js` for `<prefix>/bin/node` elsewhere.
 */
export function npmCliPath(nodeExe: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return path.win32.join(path.win32.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  }
  const prefix = path.posix.dirname(path.posix.dirname(nodeExe));
  return path.posix.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/** `npm pack` into a fresh folder; null (with the reason in `attempts`) when npm is missing or fails. */
async function viaNpm(
  ctx: Context,
  nodeExe: string,
  registry: string | undefined,
  attempts: string[],
): Promise<Fetched | null> {
  const npmCli = npmCliPath(nodeExe);
  if (!(await isFile(npmCli))) {
    attempts.push(`npm next to Node: ${npmCli} not found`);
    ctx.log(`npm not found next to Node (${npmCli}), downloading directly`);
    return null;
  }
  await mkdir(ctx.tempDir, { recursive: true });
  const workDir = await mkdtemp(path.join(ctx.tempDir, 'npm-'));
  const args = [npmCli, 'pack', ctx.label, '--pack-destination', workDir, '--json'];
  if (registry !== undefined) args.push('--registry', registry);
  ctx.log(`fetching ${ctx.label} with npm`);
  let problem: string | null;
  let file: string | null = null;
  try {
    const result = await ctx.run(nodeExe, args, {
      cwd: workDir,
      env: ctx.childEnv,
      timeoutMs: NPM_TIMEOUT_MS,
    });
    problem = runFailure(result, NPM_TIMEOUT_MS);
    if (problem === null) {
      const name = packedFileName(result.stdout);
      if (name === null) problem = `unexpected output of npm pack: ${tail(result.stdout)}`;
      else if (!(await isFile(path.join(workDir, name))))
        problem = `npm pack reported ${name}, but it is missing`;
      else file = path.join(workDir, name);
    }
  } catch (error) {
    problem = `npm could not be started: ${errorText(error)}`;
  }
  if (file !== null) return { file, workDir };
  await removeQuietly(workDir, ctx);
  attempts.push(`npm next to Node: ${problem ?? 'no file'}`);
  ctx.log(`npm failed (${problem ?? 'no file'}), downloading directly`);
  return null;
}

// ---- 4. own download ----

async function* chunksOf(body: ReadableStream): AsyncGenerator<Uint8Array> {
  const iterable: AsyncIterable<unknown> = body;
  for await (const chunk of iterable) {
    if (!(chunk instanceof Uint8Array)) throw new DownloadError('unexpected response body');
    yield chunk;
  }
}

/**
 * Reads a response body chunk by chunk, at most `maxBytes`: checked against `content-length` first
 * (nothing is read), then while reading (the stream is cancelled). `what` names the body in the
 * error. Returns the number of bytes.
 */
export async function readBodyLimited(
  response: Response,
  maxBytes: number,
  what: string,
  onChunk: (chunk: Uint8Array) => Promise<void> | void,
): Promise<number> {
  const tooLarge = new DownloadError(`${what} is larger than the limit of ${String(maxBytes)} bytes`);
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge;
  }
  if (response.body === null) return 0;
  let size = 0;
  for await (const chunk of chunksOf(response.body)) {
    size += chunk.byteLength;
    if (size > maxBytes) throw tooLarge;
    await onChunk(chunk);
  }
  return size;
}

/** GET with manual redirects: every hop is checked (protocol) and gets the auth of its own host only. */
async function request(
  ctx: Context,
  npmrc: Npmrc,
  start: URL,
  accept: string,
  signal: AbortSignal,
): Promise<Response> {
  let url = start;
  for (let hop = 0; ; hop++) {
    assertAllowedUrl(url);
    const headers: Record<string, string> = { accept };
    const auth = authFor(url.href, npmrc);
    if (auth !== null) headers.authorization = auth;
    const response = await ctx.fetch(url.href, { headers, redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (location === null) {
        throw new DownloadError(`HTTP ${response.status} without location from ${safeUrl(url)}`);
      }
      if (hop >= MAX_REDIRECTS) throw new DownloadError(`too many redirects from ${safeUrl(start)}`);
      try {
        url = new URL(location, url);
      } catch {
        throw new DownloadError(`invalid redirect from ${safeUrl(url)}`);
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new DownloadError(`HTTP ${response.status} from ${safeUrl(url)}`);
    }
    return response;
  }
}

/** `<registry>/<name with %2F>` → `versions[<version>].dist.tarball` (relative URLs resolved). */
async function tarballUrlFromRegistry(ctx: Context, npmrc: Npmrc, registry: URL): Promise<URL> {
  const metadataUrl = new URL(ctx.spec.name.replace('/', '%2F'), registry);
  const what = `the metadata from ${safeUrl(metadataUrl)}`;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await request(ctx, npmrc, metadataUrl, 'application/json', signal);
  const chunks: Uint8Array[] = [];
  await readBodyLimited(response, SDK_METADATA_MAX_BYTES, what, (chunk) => {
    chunks.push(chunk);
  });
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DownloadError(`${what} is not JSON`);
  }
  const metadata = packageMetadataSchema.safeParse(json);
  if (!metadata.success) throw new DownloadError(`${what} has no versions`);
  const version = versionMetadataSchema.safeParse(metadata.data.versions[ctx.spec.version]);
  if (!version.success) throw new DownloadError(`${what} does not list version ${ctx.spec.version}`);
  try {
    return new URL(version.data.dist.tarball, metadataUrl);
  } catch {
    throw new DownloadError(`${what} has an invalid tarball URL`);
  }
}

async function downloadTo(ctx: Context, npmrc: Npmrc, url: URL, file: string): Promise<void> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await request(ctx, npmrc, url, 'application/octet-stream', signal);
  const handle = await open(file, 'w');
  try {
    await readBodyLimited(response, SDK_MAX_BYTES, `the tarball ${safeUrl(url)}`, async (chunk) => {
      await handle.write(chunk);
    });
  } finally {
    await handle.close();
  }
}

function scopeOf(name: string): string | null {
  return name.startsWith('@') ? (name.split('/')[0] ?? null) : null;
}

/** Own download; throws `SdkError` with every attempt and the `--sdk-tarball` hint on failure. */
async function viaDownload(
  ctx: Context,
  registryOption: string | undefined,
  attempts: string[],
): Promise<Fetched> {
  let where = 'download';
  let workDir: string | null = null;
  try {
    let npmrc: Npmrc;
    try {
      npmrc = await readNpmrc(ctx.env);
    } catch (error) {
      throw new DownloadError(`cannot read .npmrc: ${errorText(error)}`);
    }
    const registryText = registryOption ?? registryFor(scopeOf(ctx.spec.name), npmrc, ctx.env);
    where = `download from ${safeUrl(registryText)}`;
    let registry: URL;
    try {
      registry = new URL(registryText.endsWith('/') ? registryText : `${registryText}/`);
    } catch {
      throw new DownloadError('invalid registry URL');
    }
    assertAllowedUrl(registry);
    ctx.log(`downloading ${ctx.label} from ${safeUrl(registry)}`);
    const tarballUrl = await tarballUrlFromRegistry(ctx, npmrc, registry);
    assertAllowedUrl(tarballUrl);
    await mkdir(ctx.tempDir, { recursive: true });
    workDir = await mkdtemp(path.join(ctx.tempDir, 'download-'));
    const file = path.join(workDir, path.basename(ctx.cacheFile));
    await downloadTo(ctx, npmrc, tarballUrl, file);
    return { file, workDir };
  } catch (error) {
    if (workDir !== null) await removeQuietly(workDir, ctx);
    attempts.push(`${where}: ${errorText(error)}`);
    throw new SdkError(
      `Could not get ${ctx.label}. Tried:\n  - ${attempts.join('\n  - ')}\n${tarballHint(ctx)}`,
      { cause: error },
    );
  }
}

// ---- entry ----

/**
 * Puts the SDK of `spec` into `target` (order: see the file comment). Throws `SdkError` with a
 * message for the user (what was tried, the `--sdk-tarball` hint).
 */
export async function provideSdk(opts: ProvideSdkOptions): Promise<{ source: SdkSource }> {
  const parsed = sdkSpecSchema.safeParse(opts.spec);
  if (!parsed.success) throw new SdkError(`invalid SDK spec: ${z.prettifyError(parsed.error)}`);
  const spec = parsed.data;
  assertUsablePath('target', opts.target);
  assertUsablePath('cache', opts.cacheDir);
  assertUsablePath('download', opts.tempDir);
  const env: Env = opts.env ?? process.env;
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value;
  const ctx: Context = {
    spec,
    label: `${spec.name}@${spec.version}`,
    target: opts.target,
    cacheDir: opts.cacheDir,
    cacheFile: path.join(opts.cacheDir, sdkCacheFileName(spec)),
    tempDir: opts.tempDir,
    env,
    childEnv,
    run: opts.run ?? runFile,
    fetch: opts.fetch ?? globalThis.fetch,
    log:
      opts.log ??
      ((line) => {
        moduleLog.info(line);
      }),
  };
  await assertTargetEmpty(ctx.target);

  if (await fromCache(ctx)) {
    await unpack(ctx);
    ctx.log(`${ctx.label}: checked tarball from the cache, unpacked`);
    return { source: 'cache' };
  }

  if (opts.tarball !== undefined) {
    const tarball = path.resolve(opts.tarball);
    assertUsablePath('--sdk-tarball', tarball);
    if (!(await isFile(tarball))) throw new SdkError(`--sdk-tarball: ${tarball} is not a file`);
    await storeInCache(ctx, tarball, `--sdk-tarball ${tarball}`, false);
    await unpack(ctx);
    ctx.log(`${ctx.label}: --sdk-tarball checked, unpacked`);
    return { source: 'tarball' };
  }

  const attempts: string[] = [];
  const npm = await viaNpm(ctx, opts.nodeExe ?? process.execPath, opts.registry, attempts);
  const source: SdkSource = npm === null ? 'download' : 'npm';
  const fetched = npm ?? (await viaDownload(ctx, opts.registry, attempts));
  try {
    await storeInCache(ctx, fetched.file, source === 'npm' ? 'npm pack' : 'download', true);
  } finally {
    await removeQuietly(fetched.workDir, ctx);
  }
  await unpack(ctx);
  ctx.log(`${ctx.label}: integrity ok (${source}), unpacked`);
  return { source };
}
