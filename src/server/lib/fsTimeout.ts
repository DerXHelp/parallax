/**
 * Timeouts for file system calls on user paths (Phase 3, ADR-141: every fs call of the file
 * service ends after 3 s – a disconnected network drive would otherwise hang a request for
 * minutes). libuv has four threadpool threads (R8): a call that timed out keeps its thread until
 * the OS answers, so a drive whose timed-out call is still pending fails fast instead of queueing
 * a second one (the same idea as the drive probes of host/fsCommands.ts, CR2-06).
 *
 * POSIX (WP-103) has no drive letters: a "drive" is the likely mount a path lies on, from the path
 * alone (no fs call – the guard must not touch a hanging mount itself): `/media/<user>/<label>`
 * (removable media on Ubuntu), `/mnt/<name>`, `/net/<host>` (autofs), `/run/user/<uid>/gvfs/<share>`
 * (GNOME network shares) resp. `/run/user/<uid>`, everything else `/`.
 *
 * Follow-up of the security review WP-109: on Linux the real mount points from `/proc/self/mountinfo`
 * (a kernel file – reading it never touches a hanging mount) refine that: the group is the deepest mount
 * the path lies on, or the guess above when that is deeper (one gvfs FUSE mount holds every share). A
 * FUSE mount in the home folder (sshfs, rclone) then hangs alone instead of taking all of `/` along.
 */
import { readFileSync } from 'node:fs';
import { pathFlavorOf, pathRules, posixPathKey, windowsPathKey, type PathRules } from '@shared/paths';

/** `HOST_PATH_RULES` of lib/paths.ts (not imported: paths.ts imports this file). */
const HOST_RULES: PathRules = pathRules(pathFlavorOf(process.platform));

/** Per fs call of the file service (ADR-141). */
export const FS_CALL_TIMEOUT_MS = 3_000;

/** An fs call that did not answer in time (→ FILE_NOT_READABLE {reason: 'timeout'}). */
export class FsTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(readonly drive: string) {
    super(`file system call on ${drive} timed out`);
    this.name = 'FsTimeoutError';
  }
}

export interface FsCallGuard {
  /**
   * Runs `call` (an fs call on `path`) and rejects with FsTimeoutError after the timeout, or at once
   * while an earlier call on the same drive is still hanging. The call itself cannot be cancelled.
   */
  run<T>(path: string, call: () => Promise<T>): Promise<T>;
  /** Drives with a timed-out call that has not ended yet (tests, logs). */
  hangingDrives(): string[];
}

/** POSIX mount group of a checked absolute path (see the file comment). */
export function posixMountGroup(path: string): string {
  const [first, second, third, fourth, fifth] = posixPathKey(path)
    .split('/')
    .filter((segment) => segment !== '');
  if (second !== undefined && (first === 'mnt' || first === 'net')) return `/${first}/${second}`;
  if (first === 'media' && second !== undefined) {
    return third === undefined ? `/media/${second}` : `/media/${second}/${third}`;
  }
  if (first === 'run' && second === 'user' && third !== undefined) {
    return fourth === 'gvfs' && fifth !== undefined
      ? `/run/user/${third}/gvfs/${fifth}`
      : `/run/user/${third}`;
  }
  return '/';
}

/** Mount points of `/proc/self/mountinfo` (field 5, octal escapes like `\040` decoded). */
export function parseMountPoints(text: string): string[] {
  const points: string[] = [];
  for (const line of text.split('\n')) {
    const field = line.split(' ')[4];
    if (!field?.startsWith('/')) continue;
    points.push(
      field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8))),
    );
  }
  return points;
}

/** The deepest of `mounts` that holds `path` (both compared as POSIX keys); `/` if none. */
export function deepestMount(path: string, mounts: readonly string[]): string {
  const key = posixPathKey(path);
  let best = '/';
  for (const mount of mounts) {
    const point = posixPathKey(mount);
    const holds = point === '/' || key === point || key.startsWith(`${point}/`);
    if (holds && point.length > best.length) best = point;
  }
  return best;
}

/**
 * Drive of a checked absolute path (Windows `c:`; POSIX its mount group, refined by the real mount
 * points when known); paths reach the guard only after the string filter.
 */
export function driveOf(
  path: string,
  rules: PathRules = HOST_RULES,
  mounts: readonly string[] | null = null,
): string {
  if (rules.flavor === 'win32') return windowsPathKey(path).slice(0, 2);
  const guess = posixMountGroup(path);
  if (mounts === null) return guess;
  const mount = deepestMount(path, mounts);
  // Both hold the path, so one lies inside the other: the deeper one is the finer group.
  return mount.length > guess.length ? mount : guess;
}

/** How long one read of `/proc/self/mountinfo` is used (mounts change rarely; the guard runs often). */
export const MOUNTS_CACHE_MS = 5_000;

/** Linux: the mount points of this process, read at most every MOUNTS_CACHE_MS; null elsewhere or unreadable. */
export function createMountReader(
  options: { platform?: NodeJS.Platform; read?: () => string; now?: () => number } = {},
): () => readonly string[] | null {
  if ((options.platform ?? process.platform) !== 'linux') return () => null;
  const read = options.read ?? (() => readFileSync('/proc/self/mountinfo', 'utf8'));
  const now = options.now ?? Date.now;
  let cached: { at: number; points: readonly string[] | null } | null = null;
  return () => {
    const at = now();
    if (cached !== null && at - cached.at < MOUNTS_CACHE_MS) return cached.points;
    let points: readonly string[] | null;
    try {
      points = parseMountPoints(read());
    } catch {
      points = null;
    }
    cached = { at, points };
    return points;
  };
}

export function createFsCallGuard(
  options: {
    timeoutMs?: number;
    rules?: PathRules;
    /** Mount points (default on the host's own rules: `createMountReader()`; with given rules none). */
    mounts?: () => readonly string[] | null;
  } = {},
): FsCallGuard {
  const timeoutMs = options.timeoutMs ?? FS_CALL_TIMEOUT_MS;
  const rules = options.rules ?? HOST_RULES;
  const mounts = options.mounts ?? (options.rules === undefined ? createMountReader() : () => null);
  /** Drive → number of timed-out calls still running. */
  const hanging = new Map<string, number>();

  const release = (drive: string): void => {
    const count = (hanging.get(drive) ?? 1) - 1;
    if (count <= 0) hanging.delete(drive);
    else hanging.set(drive, count);
  };

  return {
    run<T>(path: string, call: () => Promise<T>): Promise<T> {
      const drive = driveOf(path, rules, rules.flavor === 'win32' ? null : mounts());
      if ((hanging.get(drive) ?? 0) > 0) return Promise.reject(new FsTimeoutError(drive));
      return new Promise<T>((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          hanging.set(drive, (hanging.get(drive) ?? 0) + 1);
          reject(new FsTimeoutError(drive));
        }, timeoutMs);
        let pending: Promise<T>;
        try {
          pending = call();
        } catch (error) {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        pending.then(
          (value) => {
            clearTimeout(timer);
            if (timedOut) release(drive);
            else resolve(value);
          },
          (error: unknown) => {
            clearTimeout(timer);
            if (timedOut) release(drive);
            else reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    },
    hangingDrives: () => [...hanging.keys()],
  };
}
