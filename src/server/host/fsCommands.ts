/**
 * Folder browser `fs.listDirectory` (ADR-119, WP-30 §4.12) as a host command handler (ADR-101;
 * the engine routes by name, WP-40 wires it). Read-only; never a file system call on an unsafe
 * string (C.10) or through an unsafe link (R1-17).
 *
 * - `path: null` → the roots: the user folder (`kind: 'home'`, skipped if it is no safe drive
 *   path, e.g. a roaming profile on a share) and every drive `A:`…`Z:` whose `stat('X:\')`
 *   answers within `driveTimeoutMs` (1.5 s from the request; slow and missing drives are
 *   skipped). libuv has four threadpool threads – hanging network drives must not block every
 *   other fs call of the server (R8): a drive whose last `stat` still hangs gets no second one, and
 *   at most `DRIVE_PROBE_LIMIT` (2) drive stats run at once, in drive order; a slot is freed only
 *   when its `stat` really ends, also after a listing gave up on it (CR2-06, ADR-135). A drive still waiting
 *   for a slot at its timeout keeps the answer of its last finished stat (a local drive behind
 *   hanging network drives stays listed; one never seen is left out until it is probed).
 * - Otherwise: `windowsPathIssue` → PATH_REJECTED {reason}; `assertNoUnsafeLink` →
 *   PATH_REJECTED {reason: 'link_target'}; `stat` + `readdir(withFileTypes)`; only folders and
 *   links to folders (a link's target is checked like a path – unsafe links are left out, never
 *   followed); `hidden` = dot name or a known system folder (Node has no hidden attribute), left
 *   out without `showHidden`; sorted case-insensitively; more than `LIMITS.fsListMax` → `truncated`.
 * - Paths are the input + name exactly (no `realpath`, B "cwd exakt behalten"); `parent` is the
 *   folder above, null at a drive root.
 * - Errors: ENOENT → CWD_NOT_FOUND, no folder → CWD_NOT_DIRECTORY, EACCES/EPERM →
 *   FOLDER_NOT_READABLE {path}.
 */
import { lstat, readdir, readlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIMITS } from '@shared/common';
import { makeError } from '@shared/errors';
import type { FsEntry, FsListing } from '@shared/model';
import { windowsPathIssue, windowsPathsEqual } from '@shared/paths';
import type { HostCommand, HostCommandName } from '@shared/protocol';
import { assertNoUnsafeLink, assertSafePath, fsErrorCode, type LinkFs } from '../lib/paths';
import { CommandError, type HostCommandHandler } from '../sync/ports';

/** One directory entry (`fs.Dirent` of `readdir(…, {withFileTypes: true})`). */
export interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** File system seam of the folder browser (tests: fake links to `\\server\share`, fake drives). */
export interface DirFs extends LinkFs {
  /** Follows links. */
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  readdir(path: string): Promise<DirEntry[]>;
}

export const nodeDirFs: DirFs = {
  lstat: (file) => lstat(file),
  readlink: (file) => readlink(file),
  stat: (file) => stat(file),
  readdir: (file) => readdir(file, { withFileTypes: true }),
};

export interface FsCommandsDeps {
  fs?: DirFs;
  /** User folder of the roots (default `os.homedir()`). */
  home?: string;
  /** Drives are listed only on Windows (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** Per drive `stat` (default `DRIVE_TIMEOUT_MS`). */
  driveTimeoutMs?: number;
}

export const DRIVE_TIMEOUT_MS = 1_500;
/** Drive stats at once, counting those still hanging after their timeout (CR2-06, see the file comment). */
export const DRIVE_PROBE_LIMIT = 2;
/** `A:\` … `Z:\`. */
const DRIVE_ROOTS: readonly string[] = Array.from(
  { length: 26 },
  (_, i) => `${String.fromCharCode(65 + i)}:\\`,
);

/** One drive stat: waiting for a slot (`started` false) or running; `answer` = is it a folder. */
interface DriveProbe {
  started: boolean;
  answer: Promise<boolean>;
}

/** System folders Explorer hides (lower case); besides every name starting with `.`. */
const HIDDEN_NAMES: ReadonlySet<string> = new Set([
  '$recycle.bin',
  'system volume information',
  '$winreagent',
  'recovery',
  'config.msi',
]);

export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || HIDDEN_NAMES.has(name.toLowerCase());
}

/** Case-insensitive, then by code point (stable across locales). */
function compareNames(a: FsEntry, b: FsEntry): number {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** `dir` + `name` exactly (one separator in the input's style, the input's spelling kept). */
export function childPath(dir: string, name: string): string {
  if (/[\\/]$/.test(dir)) return `${dir}${name}`;
  const separator = dir.includes('/') && !dir.includes('\\') ? '/' : '\\';
  return `${dir}${separator}${name}`;
}

/** The folder above `dir`, null at a drive root. */
export function parentPath(dir: string): string | null {
  const parent = path.win32.dirname(dir);
  return windowsPathsEqual(parent, dir) ? null : parent;
}

function folderError(error: unknown, dir: string): unknown {
  const code = fsErrorCode(error);
  if (code === 'ENOENT') return new CommandError(makeError('CWD_NOT_FOUND'));
  if (code === 'ENOTDIR') return new CommandError(makeError('CWD_NOT_DIRECTORY'));
  if (code === 'EACCES' || code === 'EPERM') {
    return new CommandError(makeError('FOLDER_NOT_READABLE', { path: dir }));
  }
  return error;
}

/**
 * A link entry of a listing: the whole path checked (R4-10: a relative target resolves against the
 * folder the link physically lies in, also when the listed folder is reached through a link); true
 * only for a safe link to a folder.
 */
async function isSafeFolderLink(fs: DirFs, link: string): Promise<boolean> {
  try {
    await assertNoUnsafeLink(link, fs);
    return (await fs.stat(link)).isDirectory();
  } catch {
    return false;
  }
}

/** Creates the handler of `fs.listDirectory` (see the file comment). */
export function createFsCommands(deps: FsCommandsDeps = {}): HostCommandHandler {
  const fs = deps.fs ?? nodeDirFs;
  const platform = deps.platform ?? process.platform;
  const driveTimeoutMs = deps.driveTimeoutMs ?? DRIVE_TIMEOUT_MS;
  /** Drive stats waiting or running (one per drive at most, see the file comment). */
  const pendingDrives = new Map<string, DriveProbe>();
  /** Answer of the last stat of a drive that ended (CR2-06: for probes still waiting for a slot). */
  const lastAnswers = new Map<string, boolean>();
  let probing = 0;
  const waitingProbes: (() => void)[] = [];

  /** `stat(root)` once one of the `DRIVE_PROBE_LIMIT` slots is free; held until the stat ends. */
  const probeDrive = (root: string): DriveProbe => {
    const probe: DriveProbe = { started: false, answer: Promise.resolve(false) };
    probe.answer = new Promise<void>((resolve) => {
      if (probing < DRIVE_PROBE_LIMIT) {
        probing += 1;
        resolve();
      } else {
        waitingProbes.push(resolve);
      }
    })
      .then(() => {
        probe.started = true;
        return fs.stat(root);
      })
      .then(
        (info) => info.isDirectory(),
        () => false,
      )
      .then((present) => {
        lastAnswers.set(root, present);
        return present;
      })
      .finally(() => {
        const next = waitingProbes.shift();
        if (next === undefined) probing -= 1;
        else next(); // the slot passes on
      });
    return probe;
  };

  const driveAnswers = (root: string): Promise<boolean> => {
    let probe = pendingDrives.get(root);
    if (probe === undefined) {
      const created = probeDrive(root);
      pendingDrives.set(root, created);
      void created.answer.finally(() => pendingDrives.delete(root));
      probe = created;
    }
    const current = probe;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        // Still waiting behind hanging drives: its last answer (a local drive stays listed); a
        // stat that runs this long is a slow drive and skipped.
        resolve(!current.started && lastAnswers.get(root) === true);
      }, driveTimeoutMs);
    });
    return Promise.race([current.answer, timeout]).finally(() => {
      clearTimeout(timer);
    });
  };

  const roots = async (): Promise<FsListing> => {
    const entries: FsEntry[] = [];
    const home = deps.home ?? os.homedir();
    if (home !== '' && windowsPathIssue(home) === null) {
      entries.push({ name: path.win32.basename(home) || home, path: home, kind: 'home', hidden: false });
    }
    if (platform === 'win32') {
      const present = await Promise.all(DRIVE_ROOTS.map((root) => driveAnswers(root)));
      DRIVE_ROOTS.forEach((root, i) => {
        if (present[i] === true) {
          entries.push({ name: root.slice(0, 2), path: root, kind: 'drive', hidden: false });
        }
      });
    }
    return { path: null, parent: null, entries, truncated: false };
  };

  const list = async (dir: string, showHidden: boolean): Promise<FsListing> => {
    assertSafePath(dir);
    let raw: DirEntry[];
    try {
      await assertNoUnsafeLink(dir, fs);
      if (!(await fs.stat(dir)).isDirectory()) throw new CommandError(makeError('CWD_NOT_DIRECTORY'));
      raw = await fs.readdir(dir);
    } catch (error) {
      throw folderError(error, dir);
    }
    const candidates = raw.filter((entry) => showHidden || !isHiddenName(entry.name));
    const found = await Promise.all(
      candidates.map(async (entry): Promise<FsEntry | null> => {
        const entryPath = childPath(dir, entry.name);
        const hidden = isHiddenName(entry.name);
        if (entry.isSymbolicLink()) {
          return (await isSafeFolderLink(fs, entryPath))
            ? { name: entry.name, path: entryPath, kind: 'link', hidden }
            : null;
        }
        return entry.isDirectory() ? { name: entry.name, path: entryPath, kind: 'directory', hidden } : null;
      }),
    );
    const entries = found.filter((entry): entry is FsEntry => entry !== null).sort(compareNames);
    const truncated = entries.length > LIMITS.fsListMax;
    return {
      path: dir,
      parent: parentPath(dir),
      entries: truncated ? entries.slice(0, LIMITS.fsListMax) : entries,
      truncated,
    };
  };

  const names: readonly HostCommandName[] = ['fs.listDirectory'];
  return {
    names,
    handle: (cmd: HostCommand) => {
      if (cmd.name !== 'fs.listDirectory') {
        return Promise.reject(new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name })));
      }
      return cmd.path === null ? roots() : list(cmd.path, cmd.showHidden);
    },
  };
}
