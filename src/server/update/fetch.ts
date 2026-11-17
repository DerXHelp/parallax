/**
 * Network of the update service (WP-87 §2.1, docs/wp/WP-83.md §7, §9.1): plain GETs of release
 * files with redirects followed by hand – at most `MAX_REDIRECTS` hops, every hop `https:` (a
 * loopback `http:` only in a test build, `UpdateEndpoints.allowLoopbackHttp`), no user info in any
 * URL, no credentials, no cookies. A size limit per request (checked against `content-length`
 * first, then while reading), a deadline for metadata and – for the zip – an idle and a total
 * deadline, streamed to a file with the SHA-256 computed while writing.
 *
 * Own body reader instead of install/sdk.ts `readBodyLimited`: the update needs an idle timeout and
 * a typed failure (`FetchError.reason` maps to the `reason` of UPDATE_CHECK_FAILED /
 * UPDATE_DOWNLOAD_FAILED); the URL rule is the installer's (`isAllowedDownloadUrl`).
 */
import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { toError } from '../lib/async';
import { isAllowedDownloadUrl } from '../install/sdk';

export const MAX_REDIRECTS = 5;
/** latest.json, its signature, CHANGELOG.md: the whole request including the body. */
export const METADATA_TIMEOUT_MS = 30_000;
/** The zip: no data for this long aborts. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
/** The zip: the whole download. */
export const DOWNLOAD_TOTAL_TIMEOUT_MS = 15 * 60_000;

/**
 * `network` (no answer, broken body), `timeout`, `http` (`status`), `too_large`, `url` (a refused
 * hop, too many redirects, an invalid location), `disk` (writing the file), `aborted` (the caller's
 * signal, e.g. the shutdown).
 */
export type FetchFailureReason = 'network' | 'timeout' | 'http' | 'too_large' | 'url' | 'disk' | 'aborted';

export class FetchError extends Error {
  readonly reason: FetchFailureReason;
  /** HTTP status for `http`, else null. */
  readonly status: number | null;
  constructor(
    reason: FetchFailureReason,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FetchError';
    this.reason = reason;
    this.status = options.status ?? null;
  }
}

export interface UpdateFetchOptions {
  fetch: typeof fetch;
  /** Test build only (endpoints.ts): `http://127.0.0.1` / `localhost` hops are allowed. */
  allowLoopbackHttp: boolean;
  /** The caller's abort (shutdown); the failure is then `aborted`. */
  signal?: AbortSignal | undefined;
}

/** `https:` without user info; `http:` only for loopback and only when `allowLoopbackHttp`. */
export function isAllowedUpdateUrl(url: URL, allowLoopbackHttp: boolean): boolean {
  if (url.username !== '' || url.password !== '') return false;
  if (!isAllowedDownloadUrl(url)) return false;
  return url.protocol === 'https:' || allowLoopbackHttp;
}

/** URL for messages and logs: no user info, no query (signed CDN links), no fragment. */
export function safeUrl(url: URL | string): string {
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

const TIMED_OUT = Symbol('timed out');

/** One AbortController for a request: the caller's signal plus named deadlines (idle, total). */
function watchdog(outer: AbortSignal | undefined) {
  const controller = new AbortController();
  const timers = new Map<string, NodeJS.Timeout>();
  let timedOut = false;
  const onOuter = (): void => {
    controller.abort(outer?.reason);
  };
  if (outer !== undefined) {
    if (outer.aborted) onOuter();
    else outer.addEventListener('abort', onOuter, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    arm(name: string, ms: number): void {
      const old = timers.get(name);
      if (old !== undefined) clearTimeout(old);
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(TIMED_OUT);
      }, ms);
      timer.unref();
      timers.set(name, timer);
    },
    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      outer?.removeEventListener('abort', onOuter);
    },
  };
}
type Watchdog = ReturnType<typeof watchdog>;

/** The failure of a request: a deadline → timeout, the caller's abort → aborted, else as thrown. */
function classify(error: unknown, guard: Watchdog, url: string): FetchError {
  if (guard.timedOut()) return new FetchError('timeout', `${safeUrl(url)}: timed out`, { cause: error });
  if (guard.signal.aborted) return new FetchError('aborted', `${safeUrl(url)}: aborted`, { cause: error });
  if (error instanceof FetchError) return error;
  const err = toError(error);
  const cause: unknown = err.cause;
  const detail = cause instanceof Error && cause.message !== '' ? ` (${cause.message})` : '';
  return new FetchError('network', `${safeUrl(url)}: ${err.message}${detail}`, { cause: error });
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** GET `start`, following redirects by hand; resolves with the first 2xx answer. */
async function openUrl(
  start: string,
  options: UpdateFetchOptions,
  signal: AbortSignal,
  accept: string,
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    throw new FetchError('url', `invalid URL ${safeUrl(start)}`);
  }
  for (let hop = 0; ; hop++) {
    if (!isAllowedUpdateUrl(url, options.allowLoopbackHttp)) {
      throw new FetchError('url', `${safeUrl(url)} refused: only https is allowed`);
    }
    const response = await options.fetch(url.href, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept, 'cache-control': 'no-cache' },
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await cancelBody(response);
      if (location === null) {
        throw new FetchError(
          'http',
          `HTTP ${String(response.status)} without location from ${safeUrl(url)}`,
          {
            status: response.status,
          },
        );
      }
      if (hop >= MAX_REDIRECTS) throw new FetchError('url', `too many redirects from ${safeUrl(start)}`);
      try {
        url = new URL(location, url);
      } catch {
        throw new FetchError('url', `invalid redirect from ${safeUrl(url)}`);
      }
      continue;
    }
    if (!response.ok) {
      await cancelBody(response);
      throw new FetchError('http', `HTTP ${String(response.status)} from ${safeUrl(url)}`, {
        status: response.status,
      });
    }
    return response;
  }
}

/** The next chunk, or a rejection as soon as `signal` aborts (also for a body that ignores it). */
function nextChunk(iterator: AsyncIterator<unknown>, signal: AbortSignal): Promise<IteratorResult<unknown>> {
  if (signal.aborted) return Promise.reject(toError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(toError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(toError(error));
      },
    );
  });
}

/**
 * Reads the body chunk by chunk, at most `maxBytes` (`content-length` first, nothing read then);
 * `onChunk` gets every chunk. Returns the number of bytes.
 */
async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  url: string,
  onChunk: (chunk: Uint8Array) => Promise<void> | void,
): Promise<number> {
  const tooLarge = (): FetchError =>
    new FetchError('too_large', `${safeUrl(url)} is larger than ${String(maxBytes)} bytes`);
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelBody(response);
    throw tooLarge();
  }
  if (response.body === null) return 0;
  const iterable: AsyncIterable<unknown> = response.body;
  const iterator = iterable[Symbol.asyncIterator]();
  let size = 0;
  try {
    for (;;) {
      const result = await nextChunk(iterator, signal);
      if (result.done === true) return size;
      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array)) throw new FetchError('network', `${safeUrl(url)}: unexpected body`);
      size += chunk.byteLength;
      if (size > maxBytes) throw tooLarge();
      await onChunk(chunk);
    }
  } catch (error) {
    void iterator.return?.().catch(() => undefined);
    throw error;
  }
}

export interface FetchBytesOptions extends UpdateFetchOptions {
  maxBytes: number;
  /** Whole request including the body (default `METADATA_TIMEOUT_MS`). */
  timeoutMs?: number;
  accept?: string;
}

/** A small file (latest.json, its signature, CHANGELOG.md); throws `FetchError`. */
export async function fetchBytes(url: string, options: FetchBytesOptions): Promise<Buffer> {
  const guard = watchdog(options.signal);
  guard.arm('total', options.timeoutMs ?? METADATA_TIMEOUT_MS);
  try {
    const response = await openUrl(url, options, guard.signal, options.accept ?? '*/*');
    const chunks: Uint8Array[] = [];
    await readBody(response, options.maxBytes, guard.signal, url, (chunk) => {
      chunks.push(chunk);
    });
    return Buffer.concat(chunks);
  } catch (error) {
    throw classify(error, guard, url);
  } finally {
    guard.dispose();
  }
}

export interface DownloadOptions extends UpdateFetchOptions {
  maxBytes: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** After every chunk: bytes written, the expected total (`content-length` or `expected`). */
  onProgress?: (done: number, total: number | null) => void;
  /** The expected size (latest.json `size`); a larger body aborts early (`too_large`). */
  expected?: number;
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
}

/**
 * Streams `url` into `file` (created or truncated) with the SHA-256 of the written bytes. The file
 * stays on a failure – the caller removes it. Throws `FetchError` (`disk` for write failures).
 */
export async function downloadFile(
  url: string,
  file: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const guard = watchdog(options.signal);
  const idle = options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
  guard.arm('total', options.totalTimeoutMs ?? DOWNLOAD_TOTAL_TIMEOUT_MS);
  guard.arm('idle', idle);
  const hash = createHash('sha256');
  const limit = Math.min(options.maxBytes, options.expected ?? options.maxBytes);
  let handle: FileHandle | null = null;
  try {
    const response = await openUrl(url, options, guard.signal, 'application/octet-stream');
    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    const total = options.expected ?? (Number.isFinite(declared) ? declared : null);
    try {
      handle = await open(file, 'w');
    } catch (error) {
      await cancelBody(response);
      throw new FetchError('disk', `cannot write ${file}: ${toError(error).message}`, { cause: error });
    }
    const target = handle;
    let done = 0;
    options.onProgress?.(0, total);
    const bytes = await readBody(response, limit, guard.signal, url, async (chunk) => {
      guard.arm('idle', idle);
      try {
        await target.write(chunk);
      } catch (error) {
        throw new FetchError('disk', `cannot write ${file}: ${toError(error).message}`, { cause: error });
      }
      hash.update(chunk);
      done += chunk.byteLength;
      options.onProgress?.(done, total);
    });
    return { bytes, sha256: hash.digest('hex') };
  } catch (error) {
    throw classify(error, guard, url);
  } finally {
    guard.dispose();
    await handle?.close().catch(() => undefined);
  }
}
