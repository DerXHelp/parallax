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
 * once; the server is `unref()`'d and never keeps the process alive.
 *
 * Linux (WP-103, spike WP-101 §1.5): a socket in the abstract namespace `\0parallax-home-<16 hex>`
 * – exclusive like the pipe (a second bind gets EADDRINUSE), no file in the file system, free the
 * moment the process ends (also after SIGKILL). Its name is not protected by file permissions: like
 * the pipe of another Windows user (R3-16), another local user could only take the name first – a
 * denial of service, never access to the data. Other platforms: no exclusivity (`exclusive: false`).
 *
 * B1 (WP-100 §2.1): the path check uses the rules of the platform BEFORE any platform branch.
 *
 * The same mechanism serves other per-directory mutexes with their own prefix
 * (`acquireDirectoryLock`, R3-04): the launcher serializes concurrent starts per home
 * (`launch`) and concurrent builds per checkout (`build`) with it.
 */
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { pathFlavorOf, pathRules, posixPathKey, windowsPathKey } from '@shared/paths';
import { errnoCode } from './process';

export interface HomeLock {
  /**
   * The address that holds the lock: the pipe on Windows, the abstract socket on Linux (starts with
   * a NUL character); `null` without exclusivity (other platforms).
   */
  readonly pipe: string | null;
  readonly exclusive: boolean;
  /** Frees the lock (idempotent). The process end frees it as well. */
  release(): Promise<void>;
}

export type HomeLockResult =
  | { kind: 'acquired'; lock: HomeLock }
  /**
   * Another process holds the lock for this home → exit `SERVER_EXIT_CODES.alreadyRunning` (5).
   * `access_denied` (EACCES): the pipe was created by another Windows user (multi-user/RDP machine,
   * R3-16) – only a denial of service, never access to the data.
   */
  | { kind: 'busy'; pipe: string; reason: 'in_use' | 'access_denied' };

/**
 * The key of a home: the real path (Windows: junctions, `subst` drives and 8.3 names resolve to one
 * spelling; POSIX: symlinks), compared like paths of the platform (Windows `windowsPathKey`: case,
 * `/` vs `\`, trailing separator; POSIX `posixPathKey`: case-sensitive, repeated and trailing `/`).
 */
export async function homeLockKey(
  home: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const windows = platform === 'win32';
  const resolved = windows ? path.win32.resolve(home) : path.posix.resolve(home);
  let real = resolved;
  try {
    real = await realpath(resolved);
  } catch {
    // Not there yet (acquireHomeLock creates it) – the resolved path is the key.
  }
  return windows ? windowsPathKey(real) : posixPathKey(real);
}

/** Purpose of a directory lock = pipe prefix (`home`: one server per PARALLAX_HOME; `install`: one installer per installation root, WP-86). */
export type DirectoryLockKind = 'home' | 'launch' | 'build' | 'install';

function keyDigest(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

/** `\\.\pipe\parallax-<kind>-<16 hex>` for a directory key. */
export function directoryLockPipeName(kind: DirectoryLockKind, key: string): string {
  return `\\\\.\\pipe\\parallax-${kind}-${keyDigest(key)}`;
}

/** `\0parallax-<kind>-<16 hex>` (Linux abstract namespace) for a directory key. */
export function directoryLockSocketName(kind: DirectoryLockKind, key: string): string {
  return `\0parallax-${kind}-${keyDigest(key)}`;
}

/** `\\.\pipe\parallax-home-<16 hex>` for a home key. */
export function homeLockPipeName(key: string): string {
  return directoryLockPipeName('home', key);
}

/** The lock address of the platform, or null where there is no exclusive lock. */
function lockAddress(kind: DirectoryLockKind, key: string, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return directoryLockPipeName(kind, key);
  if (platform === 'linux') return directoryLockSocketName(kind, key);
  return null;
}

function listen(server: Server, pipe: string): Promise<'listening' | 'in_use' | 'access_denied'> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      if (errnoCode(error) === 'EADDRINUSE') resolve('in_use');
      else if (errnoCode(error) === 'EACCES') resolve('access_denied');
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
export function acquireHomeLock(home: string, options: AcquireHomeLockOptions = {}): Promise<HomeLockResult> {
  return acquireDirectoryLock('home', home, options);
}

/**
 * The exclusive lock `kind` of `dir` (absolute, safe path after the rules of the platform; created
 * if missing so that its real path is the key – same key rules as the home lock). `busy` if another
 * holder has it. Without an exclusive lock on the platform nothing is touched.
 */
export async function acquireDirectoryLock(
  kind: DirectoryLockKind,
  dir: string,
  options: AcquireHomeLockOptions = {},
): Promise<HomeLockResult> {
  const platform = options.platform ?? process.platform;
  const issue = pathRules(pathFlavorOf(platform)).issue(dir);
  if (issue !== null) throw new TypeError(`${kind} lock: unsafe path (${issue})`);
  if (lockAddress(kind, '', platform) === null) return acquireKeyLock(kind, '', options);
  // Security review WP-109: a new data folder is the user's alone from the start (POSIX 0700; the
  // server narrows an existing one before its first store, app/compose.ts).
  await mkdir(dir, kind === 'home' ? { recursive: true, mode: 0o700 } : { recursive: true });
  return acquireKeyLock(kind, await homeLockKey(dir, platform), options);
}

/**
 * The exclusive lock `kind` for an already computed directory key – the pipe/socket part of
 * `acquireDirectoryLock`, WITHOUT any file system access or path check. For a directory the
 * process works in anyway (the checkout of the build lock, CR-04: also a checkout on a UNC share).
 */
export async function acquireKeyLock(
  kind: DirectoryLockKind,
  key: string,
  options: AcquireHomeLockOptions = {},
): Promise<HomeLockResult> {
  const pipe = lockAddress(kind, key, options.platform ?? process.platform);
  if (pipe === null) {
    return { kind: 'acquired', lock: { pipe: null, exclusive: false, release: () => Promise.resolve() } };
  }
  const server = createServer((socket) => {
    socket.destroy();
  });
  const listened = await listen(server, pipe);
  if (listened !== 'listening') {
    server.close();
    return { kind: 'busy', pipe, reason: listened };
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
