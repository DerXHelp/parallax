import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_SDK_PACKAGE } from '../launcher/release';
import { runFile, systemTool, type RunFileFn, type RunFileOptions, type RunFileResult } from '../lib/process';
import {
  NPM_TIMEOUT_MS,
  SDK_MAX_BYTES,
  SdkError,
  isAllowedDownloadUrl,
  packedFileName,
  provideSdk,
  readBodyLimited,
  sdkCacheFileName,
  type ProvideSdkOptions,
  type SdkSpec,
} from './sdk';

const VERSION = '1.2.3';
const CACHE_NAME = `anthropic-ai-claude-agent-sdk-${VERSION}.tgz`;
const METADATA_PATH = '/@anthropic-ai%2Fclaude-agent-sdk';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'parallax-sdk-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

interface Tarball {
  file: string;
  bytes: Uint8Array<ArrayBuffer>;
  integrity: string;
}

/** A small npm-style tarball (`package/…`), packed with the real System32 tar.exe. */
async function makeTarball(label: string, name = AGENT_SDK_PACKAGE, version = VERSION): Promise<Tarball> {
  const src = path.join(dir, `src-${label}`);
  await mkdir(path.join(src, 'package'), { recursive: true });
  await writeFile(path.join(src, 'package', 'package.json'), JSON.stringify({ name, version }));
  await writeFile(path.join(src, 'package', 'sdk.mjs'), `export const label = '${label}';\n`);
  const file = path.join(dir, `${label}.tgz`);
  const result = await runFile(systemTool('tar.exe'), ['-c', '-z', '-f', file, '-C', src, 'package'], {
    timeoutMs: 60_000,
  });
  expect(result.exitCode).toBe(0);
  const bytes = new Uint8Array(await readFile(file));
  return { file, bytes, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
}

function spec(integrity: string): SdkSpec {
  return { name: AGENT_SDK_PACKAGE, version: VERSION, integrity };
}

function folders(): { target: string; cacheDir: string; tempDir: string } {
  return {
    target: path.join(dir, 'versions', VERSION, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
    cacheDir: path.join(dir, 'cache'),
    tempDir: path.join(dir, 'downloads'),
  };
}

/** Never the real profile: `.npmrc` comes from the test folder only. */
function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    USERPROFILE: path.join(dir, 'profile'),
    ...extra,
  };
}

/** A node.exe path whose folder has (or lacks) `node_modules\npm\bin\npm-cli.js` – never started. */
async function fakeNode(withNpm: boolean): Promise<{ nodeExe: string; npmCli: string }> {
  const nodeDir = path.join(dir, withNpm ? 'node-npm' : 'node-bare');
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (withNpm) {
    await mkdir(path.dirname(npmCli), { recursive: true });
    await writeFile(npmCli, '// fake');
  } else {
    await mkdir(nodeDir, { recursive: true });
  }
  return { nodeExe: path.join(nodeDir, 'node.exe'), npmCli };
}

type NpmFake = (args: readonly string[], options: RunFileOptions) => Promise<RunFileResult>;

interface RunCall {
  file: string;
  args: readonly string[];
  options: RunFileOptions;
}

/** `run` seam: tar.exe runs for real, node.exe (npm) is faked or refused. */
function makeRun(npm?: NpmFake): { run: RunFileFn; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: RunFileFn = (file, args, options) => {
    calls.push({ file, args, options });
    if (path.basename(file).toLowerCase() === 'tar.exe') return runFile(file, args, options);
    if (npm === undefined) return Promise.reject(new Error(`unexpected spawn of ${file}`));
    return npm(args, options);
  };
  return { run, calls };
}

function result(partial: Partial<RunFileResult>): RunFileResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...partial };
}

/** Fake `npm pack`: copies `source` into `--pack-destination` and prints the JSON like npm 11. */
function packInto(source: string): NpmFake {
  return async (args) => {
    const dest = args[args.indexOf('--pack-destination') + 1];
    if (dest === undefined) throw new Error('no --pack-destination');
    await copyFile(source, path.join(dest, CACHE_NAME));
    const json = JSON.stringify([{ id: `${AGENT_SDK_PACKAGE}@${VERSION}`, filename: CACHE_NAME }]);
    return result({ stdout: `npm notice packing\n${json}\n` });
  };
}

interface FetchCall {
  url: string;
  auth: string | null;
  accept: string | null;
  redirect: RequestInit['redirect'];
}

function fakeFetch(handler: (url: string) => Response): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      auth: headers.get('authorization'),
      accept: headers.get('accept'),
      redirect: init?.redirect,
    });
    try {
      return Promise.resolve(handler(url));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return { fetch: fn, calls };
}

const noFetch: typeof fetch = () => Promise.reject(new Error('the network must not be used'));

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function metadata(tarballUrl: string): unknown {
  return {
    name: AGENT_SDK_PACKAGE,
    versions: {
      '1.0.0': { dist: { tarball: 'https://registry.example/old.tgz' } },
      [VERSION]: { name: AGENT_SDK_PACKAGE, version: VERSION, dist: { tarball: tarballUrl, shasum: 'x' } },
    },
  };
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function expectUnpacked(target: string, label: string): Promise<void> {
  const pkg: unknown = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
  expect(pkg).toEqual({ name: AGENT_SDK_PACKAGE, version: VERSION });
  expect(await readFile(path.join(target, 'sdk.mjs'), 'utf8')).toContain(label);
}

async function rejection(promise: Promise<unknown>): Promise<SdkError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SdkError);
  if (!(error instanceof SdkError)) throw new Error('expected an SdkError');
  return error;
}

describe('provideSdk – cache and --sdk-tarball', () => {
  it('uses a matching cache entry without npm or network', async () => {
    const good = await makeTarball('good');
    const paths = folders();
    await mkdir(paths.cacheDir, { recursive: true });
    await copyFile(good.file, path.join(paths.cacheDir, CACHE_NAME));
    const { nodeExe } = await fakeNode(true);
    const { run, calls } = makeRun();
    const lines: string[] = [];
    const out = await provideSdk({
      ...paths,
      spec: spec(good.integrity),
      nodeExe,
      env: testEnv(),
      run,
      fetch: noFetch,
      log: (line) => lines.push(line),
    });
    expect(out).toEqual({ source: 'cache' });
    await expectUnpacked(paths.target, 'good');
    expect(calls.map((call) => path.basename(call.file))).toEqual(['tar.exe']);
    expect(calls[0]?.args).toEqual([
      '-x',
      '-z',
      '-f',
      path.join(paths.cacheDir, CACHE_NAME),
      '--strip-components=1',
      '-C',
      paths.target,
    ]);
    expect(lines.join('\n')).toContain('cache');
  });

  it('removes a damaged cache entry and takes the next source', async () => {
    const good = await makeTarball('good');
    const paths = folders();
    await mkdir(paths.cacheDir, { recursive: true });
    await writeFile(path.join(paths.cacheDir, CACHE_NAME), 'damaged');
    const lines: string[] = [];
    const out = await provideSdk({
      ...paths,
      spec: spec(good.integrity),
      tarball: good.file,
      env: testEnv(),
      run: makeRun().run,
      fetch: noFetch,
      log: (line) => lines.push(line),
    });
    expect(out).toEqual({ source: 'tarball' });
    expect(lines.some((line) => line.includes('removed'))).toBe(true);
    expect(new Uint8Array(await readFile(path.join(paths.cacheDir, CACHE_NAME)))).toEqual(good.bytes);
    expect(await readdir(paths.cacheDir)).toEqual([CACHE_NAME]);
    await expectUnpacked(paths.target, 'good');
  });

  it('refuses a --sdk-tarball with a wrong hash, keeps the file and falls back to nothing', async () => {
    const good = await makeTarball('good');
    const other = await makeTarball('other');
    const paths = folders();
    const { nodeExe } = await fakeNode(true);
    const { run, calls } = makeRun(packInto(good.file));
    const error = await rejection(
      provideSdk({
        ...paths,
        spec: spec(good.integrity),
        tarball: other.file,
        nodeExe,
        env: testEnv(),
        run,
        fetch: noFetch,
        log: () => undefined,
      }),
    );
    expect(error.message).toContain('--sdk-tarball');
    expect(error.message).toContain('SHA-512');
    expect(await exists(other.file)).toBe(true);
    expect(calls).toEqual([]);
    expect(await readdir(paths.cacheDir)).toEqual([]);
    expect(await exists(paths.target)).toBe(false);
  });

  it('refuses a non-empty target and an invalid spec', async () => {
    const good = await makeTarball('good');
    const paths = folders();
    await mkdir(paths.target, { recursive: true });
    await writeFile(path.join(paths.target, 'stale.js'), 'x');
    const base: ProvideSdkOptions = {
      ...paths,
      spec: spec(good.integrity),
      tarball: good.file,
      env: testEnv(),
      run: makeRun().run,
      fetch: noFetch,
      log: () => undefined,
    };
    expect((await rejection(provideSdk(base))).message).toContain('not empty');
    const invalid = { ...base, spec: { ...spec(good.integrity), version: '../1.2.3' } };
    expect((await rejection(provideSdk(invalid))).message).toContain('invalid SDK spec');
    const unc = { ...base, cacheDir: '\\\\server\\share\\cache' };
    expect((await rejection(provideSdk(unc))).message).toContain('unc');
  });

  it('checks name and version of the unpacked package.json', async () => {
    const wrong = await makeTarball('wrong', 'other-package');
    const paths = folders();
    const error = await rejection(
      provideSdk({
        ...paths,
        spec: spec(wrong.integrity),
        tarball: wrong.file,
        env: testEnv(),
        run: makeRun().run,
        fetch: noFetch,
        log: () => undefined,
      }),
    );
    expect(error.message).toContain(`package.json is other-package@${VERSION}`);
    expect(await exists(paths.target)).toBe(false);
  });
});

describe('provideSdk – npm next to node', () => {
  it('packs with npm-cli.js next to node, checks, caches and unpacks', async () => {
    const good = await makeTarball('good');
    const paths = folders();
    const { nodeExe, npmCli } = await fakeNode(true);
    const { run, calls } = makeRun(packInto(good.file));
    const out = await provideSdk({
      ...paths,
      spec: spec(good.integrity),
      registry: 'https://registry.example/',
      nodeExe,
      env: testEnv(),
      run,
      fetch: noFetch,
      log: () => undefined,
    });
    expect(out).toEqual({ source: 'npm' });
    const npmCall = calls[0];
    expect(npmCall?.file).toBe(nodeExe);
    const dest = npmCall?.args[4] ?? '';
    expect(npmCall?.args).toEqual([
      npmCli,
      'pack',
      `${AGENT_SDK_PACKAGE}@${VERSION}`,
      '--pack-destination',
      dest,
      '--json',
      '--registry',
      'https://registry.example/',
    ]);
    expect(path.dirname(dest)).toBe(paths.tempDir);
    expect(npmCall?.options).toMatchObject({ cwd: dest, timeoutMs: NPM_TIMEOUT_MS });
    expect(await readdir(paths.tempDir)).toEqual([]);
    expect(new Uint8Array(await readFile(path.join(paths.cacheDir, CACHE_NAME)))).toEqual(good.bytes);
    await expectUnpacked(paths.target, 'good');
  });

  it('a wrong hash from npm is an error (file removed, nothing cached, no download)', async () => {
    const good = await makeTarball('good');
    const other = await makeTarball('other');
    const paths = folders();
    const { nodeExe } = await fakeNode(true);
    const error = await rejection(
      provideSdk({
        ...paths,
        spec: spec(good.integrity),
        nodeExe,
        env: testEnv(),
        run: makeRun(packInto(other.file)).run,
        fetch: noFetch,
        log: () => undefined,
      }),
    );
    expect(error.message).toContain('npm pack');
    expect(error.message).toContain('--sdk-tarball');
    expect(await readdir(paths.tempDir)).toEqual([]);
    expect(await readdir(paths.cacheDir)).toEqual([]);
  });

  it.each([
    ['missing', false, undefined],
    [
      'failing',
      true,
      (): Promise<RunFileResult> => Promise.resolve(result({ exitCode: 1, stderr: 'npm error E404' })),
    ],
    ['printing nonsense', true, (): Promise<RunFileResult> => Promise.resolve(result({ stdout: 'hello' }))],
  ] as const)('npm %s → own download', async (_label, withNpm, npm) => {
    const good = await makeTarball('good');
    const paths = folders();
    const { nodeExe } = await fakeNode(withNpm);
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith(METADATA_PATH)
        ? jsonResponse(metadata('https://registry.npmjs.org/sdk.tgz'))
        : new Response(good.bytes),
    );
    const out = await provideSdk({
      ...paths,
      spec: spec(good.integrity),
      nodeExe,
      env: testEnv(),
      run: makeRun(npm).run,
      fetch,
      log: () => undefined,
    });
    expect(out).toEqual({ source: 'download' });
    expect(calls.map((call) => call.url)).toEqual([
      `https://registry.npmjs.org${METADATA_PATH}`,
      'https://registry.npmjs.org/sdk.tgz',
    ]);
    expect(await readdir(paths.tempDir)).toEqual([]);
    await expectUnpacked(paths.target, 'good');
  });
});

describe('provideSdk – own download', () => {
  it('takes the scope registry and the token from .npmrc, only for that host', async () => {
    const good = await makeTarball('good');
    const paths = folders();
    const npmrc = path.join(dir, 'config', 'user.npmrc');
    await mkdir(path.dirname(npmrc), { recursive: true });
    await writeFile(
      npmrc,
      [
        'registry=https://wrong.example/',
        '@anthropic-ai:registry=https://registry.example/npm/',
        '//registry.example/npm/:_authToken=${TEST_SDK_TOKEN}',
      ].join('\n'),
    );
    const { nodeExe } = await fakeNode(false);
    const tarballUrl = `https://registry.example/npm/${AGENT_SDK_PACKAGE}/-/claude-agent-sdk-${VERSION}.tgz`;
    const { fetch, calls } = fakeFetch((url) => {
      if (url === `https://registry.example/npm${METADATA_PATH}`) return jsonResponse(metadata(tarballUrl));
      if (url === tarballUrl) {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example/blob?sig=abc' } });
      }
      if (url === 'https://cdn.example/blob?sig=abc') return new Response(good.bytes);
      return new Response('not found', { status: 404 });
    });
    const out = await provideSdk({
      ...paths,
      spec: spec(good.integrity),
      nodeExe,
      env: testEnv({ NPM_CONFIG_USERCONFIG: npmrc, TEST_SDK_TOKEN: 'invented-token-1' }),
      run: makeRun().run,
      fetch,
      log: () => undefined,
    });
    expect(out).toEqual({ source: 'download' });
    expect(calls).toEqual([
      {
        url: `https://registry.example/npm${METADATA_PATH}`,
        auth: 'Bearer invented-token-1',
        accept: 'application/json',
        redirect: 'manual',
      },
      {
        url: tarballUrl,
        auth: 'Bearer invented-token-1',
        accept: 'application/octet-stream',
        redirect: 'manual',
      },
      {
        url: 'https://cdn.example/blob?sig=abc',
        auth: null,
        accept: 'application/octet-stream',
        redirect: 'manual',
      },
    ]);
    await expectUnpacked(paths.target, 'good');
  });

  it('refuses http outside loopback (registry and redirect) before any request', async () => {
    const good = await makeTarball('good');
    const { nodeExe } = await fakeNode(false);
    const { fetch, calls } = fakeFetch(() => new Response('unused'));
    const error = await rejection(
      provideSdk({
        ...folders(),
        spec: spec(good.integrity),
        registry: 'http://registry.example/',
        nodeExe,
        env: testEnv(),
        run: makeRun().run,
        fetch,
        log: () => undefined,
      }),
    );
    expect(error.message).toContain('only https: is allowed');
    expect(error.message).toContain('--sdk-tarball <file>');
    expect(calls).toEqual([]);

    const redirecting = fakeFetch((url) =>
      url.endsWith(METADATA_PATH)
        ? jsonResponse(metadata('https://registry.example/sdk.tgz'))
        : new Response(null, { status: 301, headers: { location: 'http://cdn.example/sdk.tgz' } }),
    );
    const downgraded = await rejection(
      provideSdk({
        ...folders(),
        spec: spec(good.integrity),
        registry: 'https://registry.example',
        nodeExe,
        env: testEnv(),
        run: makeRun().run,
        fetch: redirecting.fetch,
        log: () => undefined,
      }),
    );
    expect(downgraded.message).toContain('http://cdn.example/sdk.tgz refused');
    expect(redirecting.calls.map((call) => call.url)).toEqual([
      `https://registry.example${METADATA_PATH}`,
      'https://registry.example/sdk.tgz',
    ]);
  });

  it('allows http only for 127.0.0.1 and localhost', () => {
    expect(isAllowedDownloadUrl(new URL('https://registry.example/'))).toBe(true);
    expect(isAllowedDownloadUrl(new URL('http://127.0.0.1:4873/'))).toBe(true);
    expect(isAllowedDownloadUrl(new URL('http://localhost:4873/'))).toBe(true);
    expect(isAllowedDownloadUrl(new URL('http://registry.example/'))).toBe(false);
    expect(isAllowedDownloadUrl(new URL('http://127.0.0.2/'))).toBe(false);
    expect(isAllowedDownloadUrl(new URL('ftp://127.0.0.1/'))).toBe(false);
  });

  it('refuses a tarball over the size limit before reading it', async () => {
    const good = await makeTarball('good');
    const { nodeExe } = await fakeNode(false);
    const paths = folders();
    const { fetch } = fakeFetch((url) =>
      url.endsWith(METADATA_PATH)
        ? jsonResponse(metadata('https://registry.example/sdk.tgz'))
        : new Response(good.bytes, { headers: { 'content-length': String(SDK_MAX_BYTES + 1) } }),
    );
    const error = await rejection(
      provideSdk({
        ...paths,
        spec: spec(good.integrity),
        registry: 'https://registry.example/',
        nodeExe,
        env: testEnv(),
        run: makeRun().run,
        fetch,
        log: () => undefined,
      }),
    );
    expect(error.message).toContain(`larger than the limit of ${String(SDK_MAX_BYTES)} bytes`);
    expect(await readdir(paths.tempDir)).toEqual([]);
    expect(await exists(paths.target)).toBe(false);
  });

  it('stops reading a body without content-length at the limit and cancels it', async () => {
    let cancelled = false;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    const seen: number[] = [];
    await expect(
      readBodyLimited(new Response(body), 20, 'the test body', (chunk) => {
        seen.push(chunk.byteLength);
      }),
    ).rejects.toThrow('the test body is larger than the limit of 20 bytes');
    expect(seen).toEqual([8, 8]);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it('a wrong hash from the download is an error (file removed, nothing cached)', async () => {
    const good = await makeTarball('good');
    const other = await makeTarball('other');
    const { nodeExe } = await fakeNode(false);
    const paths = folders();
    const { fetch } = fakeFetch((url) =>
      url.endsWith(METADATA_PATH)
        ? jsonResponse(metadata('https://registry.example/sdk.tgz'))
        : new Response(other.bytes),
    );
    const error = await rejection(
      provideSdk({
        ...paths,
        spec: spec(good.integrity),
        registry: 'https://registry.example/',
        nodeExe,
        env: testEnv(),
        run: makeRun().run,
        fetch,
        log: () => undefined,
      }),
    );
    expect(error.message).toContain('download: the SHA-512 of the tarball does not match');
    expect(await readdir(paths.tempDir)).toEqual([]);
    expect(await readdir(paths.cacheDir)).toEqual([]);
  });

  it('lists every attempt and the --sdk-tarball hint when nothing works, without secrets', async () => {
    const good = await makeTarball('good');
    const { nodeExe } = await fakeNode(true);
    const npmrc = path.join(dir, 'user.npmrc');
    await writeFile(npmrc, '//registry.npmjs.org/:_authToken=invented-secret-2');
    const failing: typeof fetch = () =>
      Promise.reject(
        new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND registry.npmjs.org') }),
      );
    const error = await rejection(
      provideSdk({
        ...folders(),
        spec: spec(good.integrity),
        nodeExe,
        env: testEnv({ NPM_CONFIG_USERCONFIG: npmrc }),
        run: makeRun(() => Promise.resolve(result({ exitCode: 1, stderr: 'npm error network unreachable' })))
          .run,
        fetch: failing,
        log: () => undefined,
      }),
    );
    expect(error.message).toContain(`Could not get ${AGENT_SDK_PACKAGE}@${VERSION}`);
    expect(error.message).toContain('npm next to Node: exit 1: npm error network unreachable');
    expect(error.message).toContain(
      'download from https://registry.npmjs.org/: fetch failed (getaddrinfo ENOTFOUND registry.npmjs.org)',
    );
    expect(error.message).toContain('--sdk-tarball <file>');
    expect(error.message).not.toContain('invented-secret-2');

    const unauthorized = fakeFetch(() => new Response('denied', { status: 401 }));
    const denied = await rejection(
      provideSdk({
        ...folders(),
        spec: spec(good.integrity),
        nodeExe: (await fakeNode(false)).nodeExe,
        env: testEnv({ NPM_CONFIG_USERCONFIG: npmrc }),
        run: makeRun().run,
        fetch: unauthorized.fetch,
        log: () => undefined,
      }),
    );
    expect(denied.message).toContain(`HTTP 401 from https://registry.npmjs.org${METADATA_PATH}`);
    expect(denied.message).not.toContain('invented-secret-2');
    expect(unauthorized.calls[0]?.auth).toBe('Bearer invented-secret-2');
  });

  it('downloads from a loopback registry with the real fetch (redirect, token per host)', async () => {
    const good = await makeTarball('good');
    const seen: { url: string; auth: string | undefined }[] = [];
    let base = '';
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization });
      if (req.url === METADATA_PATH) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(metadata(`${base}/files/sdk.tgz`)));
      } else if (req.url === '/files/sdk.tgz') {
        res.writeHead(302, { location: '/blob/sdk.tgz' }).end();
      } else if (req.url === '/blob/sdk.tgz') {
        res.end(good.bytes);
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      base = `http://127.0.0.1:${String(address.port)}`;
      const npmrc = path.join(dir, 'loopback.npmrc');
      await writeFile(npmrc, `//127.0.0.1:${String(address.port)}/:_authToken=invented-loopback-token\n`);
      const paths = folders();
      const out = await provideSdk({
        ...paths,
        spec: spec(good.integrity),
        registry: base,
        nodeExe: (await fakeNode(false)).nodeExe,
        env: testEnv({ NPM_CONFIG_USERCONFIG: npmrc }),
        run: makeRun().run,
        log: () => undefined,
      });
      expect(out).toEqual({ source: 'download' });
      expect(seen).toEqual([
        { url: METADATA_PATH, auth: 'Bearer invented-loopback-token' },
        { url: '/files/sdk.tgz', auth: 'Bearer invented-loopback-token' },
        { url: '/blob/sdk.tgz', auth: 'Bearer invented-loopback-token' },
      ]);
      await expectUnpacked(paths.target, 'good');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });
});

describe('helpers', () => {
  it('names the cache file like npm pack', () => {
    expect(sdkCacheFileName({ name: AGENT_SDK_PACKAGE, version: '0.3.322' })).toBe(
      'anthropic-ai-claude-agent-sdk-0.3.322.tgz',
    );
    expect(sdkCacheFileName({ name: 'plain', version: '1.0.0' })).toBe('plain-1.0.0.tgz');
  });

  it('reads the file name from npm pack --json', () => {
    expect(packedFileName(`npm notice\n[{"filename":"${CACHE_NAME}","size":1}]\n`)).toBe(CACHE_NAME);
    expect(packedFileName('[{"filename":"..\\\\..\\\\evil.tgz"}]')).toBe('evil.tgz');
    expect(packedFileName('[{"filename":"x.zip"}]')).toBeNull();
    expect(packedFileName('[]')).toBeNull();
    expect(packedFileName('no json')).toBeNull();
  });
});
