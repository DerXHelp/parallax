/**
 * Exclusive lock per `PARALLAX_HOME` (R2-05, B "Persistenz": never two writers on one data
 * directory). The lock file (`server.lock.json`) only helps the launcher and only after `listen`;
 * two servers started at once (double click, a second `--port`, `pnpm dev:live --home=<real home>`)
 * would both open the stores, run the recovery and the orphan cleanup. This mutex is taken BEFORE
 * the first store is opened (wiring: WP-20c, `src/server/main.ts`).
 *
 * Windows: a named pipe `\\.\pipe\parallax-home-<16 hex of sha256(path key)>`. libuv creates the
 * first instance with FILE_FLAG_FIRST_PIPE_INSTANCE, so a second `listen` – from any process of any
 * session – fails with EADDRINUSE (probe in docs/wp/R2.md). The pipe disappears with the process
 * (also after a crash or taskkill): there is no stale state. Connections to the pipe are closed at
 * once; the server is `unref()`'d and never keeps the process alive. Other platforms (tests only):
 * no exclusivity (`exclusive: false`).
 */
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { windowsPathIssue, windowsPathKey } from '@shared/paths';
import { errnoCode } from './process';

export interface HomeLock {
  /** The pipe that holds the lock (`null` without exclusivity, non-Windows). */
  readonly pipe: string | null;
  readonly exclusive: boolean;
  /** Frees the lock (idempotent). The process end frees it as well. */
  release(): Promise<void>;
}

export type HomeLockResult =
  | { kind: 'acquired'; lock: HomeLock }
  /** Another process holds the lock for this home → exit `SERVER_EXIT_CODES.alreadyRunning` (5). */
  | { kind: 'busy'; pipe: string };

/**
 * The key of a home: the real path (junctions, `subst` drives and 8.3 names resolve to one
 * spelling), compared like Windows paths (`windowsPathKey`: case, `/` vs `\`, trailing separator).
 */
export async function homeLockKey(home: string): Promise<string> {
  const resolved = path.win32.resolve(home);
  let real = resolved;
  try {
    real = await realpath(resolved);
  } catch {
    // Not there yet (acquireHomeLock creates it) – the resolved path is the key.
  }
  return windowsPathKey(real);
}

/** `\\.\pipe\parallax-home-<16 hex>` for a home key. */
export function homeLockPipeName(key: string): string {
  const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\parallax-home-${digest}`;
}

function listen(server: Server, pipe: string): Promise<'listening' | 'busy'> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      if (errnoCode(error) === 'EADDRINUSE' || errnoCode(error) === 'EACCES') resolve('busy');
      else reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve('listening');
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipe);
  });
}

export interface AcquireHomeLockOptions {
  /** Test seam (default `process.platform`). */
  platform?: NodeJS.Platform;
}

/**
 * Takes the exclusive lock of `home` (absolute, safe path – it is created if missing so that its
 * real path is the key). `busy` if another process holds it; other failures reject.
 */
export async function acquireHomeLock(
  home: string,
  options: AcquireHomeLockOptions = {},
): Promise<HomeLockResult> {
  const issue = windowsPathIssue(home);
  if (issue !== null) throw new TypeError(`home lock: unsafe PARALLAX_HOME (${issue})`);
  if ((options.platform ?? process.platform) !== 'win32') {
    return { kind: 'acquired', lock: { pipe: null, exclusive: false, release: () => Promise.resolve() } };
  }
  await mkdir(home, { recursive: true });
  const pipe = homeLockPipeName(await homeLockKey(home));
  const server = createServer((socket) => {
    socket.destroy();
  });
  if ((await listen(server, pipe)) === 'busy') {
    server.close();
    return { kind: 'busy', pipe };
  }
  server.unref();
  let released: Promise<void> | null = null;
  return {
    kind: 'acquired',
    lock: {
      pipe,
      exclusive: true,
      release: () => {
        released ??= new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
        return released;
      },
    },
  };
}
