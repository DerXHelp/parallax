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
 */
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

/**
 * Drive of a checked absolute path (Windows `c:`; POSIX its mount group); paths reach the guard only
 * after the string filter.
 */
export function driveOf(path: string, rules: PathRules = HOST_RULES): string {
  return rules.flavor === 'win32' ? windowsPathKey(path).slice(0, 2) : posixMountGroup(path);
}

export function createFsCallGuard(options: { timeoutMs?: number; rules?: PathRules } = {}): FsCallGuard {
  const timeoutMs = options.timeoutMs ?? FS_CALL_TIMEOUT_MS;
  const rules = options.rules ?? HOST_RULES;
  /** Drive → number of timed-out calls still running. */
  const hanging = new Map<string, number>();

  const release = (drive: string): void => {
    const count = (hanging.get(drive) ?? 1) - 1;
    if (count <= 0) hanging.delete(drive);
    else hanging.set(drive, count);
  };

  return {
    run<T>(path: string, call: () => Promise<T>): Promise<T> {
      const drive = driveOf(path, rules);
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
