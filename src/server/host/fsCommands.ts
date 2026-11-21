/**
 * Folder browser `fs.listDirectory` (ADR-119, WP-30 §4.12) and `fs.createDirectory` (WP-94,
 * ADR-235) as a host command handler (ADR-101; the engine routes by name, WP-40 wires it). Never a
 * file system call on an unsafe string (C.10) or through an unsafe link (R1-17).
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
 * - Otherwise: `rules.issue` (host path rules) → PATH_REJECTED {reason}; `assertNoUnsafeLink` →
 *   PATH_REJECTED {reason: 'link_target'}; `stat` + `readdir(withFileTypes)`; only folders and
 *   links to folders (a link's target is checked like a path – unsafe links are left out, never
 *   followed); `hidden` = dot name or a known system folder (Node has no hidden attribute), left
 *   out without `showHidden`; sorted case-insensitively; more than `LIMITS.fsListMax` → `truncated`.
 * - Paths are the input + name exactly (no `realpath`, B "cwd exakt behalten"); `parent` is the
 *   folder above, null at a drive root.
 * - Errors: ENOENT → CWD_NOT_FOUND, no folder → CWD_NOT_DIRECTORY, EACCES/EPERM →
 *   FOLDER_NOT_READABLE {path}.
 *
 * `fs.createDirectory {parent, folderName}`: the parent is checked like a listed folder (string,
 * links, exists, is a folder); `rules.nameIssue(folderName)` → PATH_REJECTED {reason}; then ONE
 * `mkdir` of `childPath(parent, folderName)` – never recursive, so only a folder the user named is
 * created. EEXIST → FOLDER_EXISTS {path}, EACCES/EPERM/EROFS → FOLDER_NOT_WRITABLE {path: parent}.
 *
 * POSIX hosts (WP-103, `FsCommandsDeps.platform`): every check uses the POSIX path rules
 * (case-sensitive, `/`). The roots are the user folder, `/`, `/media/<user>` and `/mnt` (`kind:
 * 'drive'`, each only when its `stat` answers in time, same probe limits as the drives); `hidden` is
 * a dot name only; `parent` of `/` is null.
 */
import { lstat, mkdir, readdir, readlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIMITS } from '@shared/common';
import { makeError } from '@shared/errors';
import type { FsEntry, FsListing } from '@shared/model';
import { pathFlavorOf, pathRules, WIN32_PATHS, type PathRules } from '@shared/paths';
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
  /**
   * Path rules and roots of this platform (default `process.platform`): drives on Windows; `/`,
   * `/media/<user>` and `/mnt` elsewhere (WP-103).
   */
  platform?: NodeJS.Platform;
  /** POSIX: the user name of `/media/<user>` (default `os.userInfo().username`). */
  userName?: string;
  /** Per drive `stat` (default `DRIVE_TIMEOUT_MS`). */
  driveTimeoutMs?: number;
  /** `fs.createDirectory`: creates one folder, never recursive (default `fs.promises.mkdir`). */
  mkdir?: (dir: string) => Promise<void>;
}

const nodeMkdir = async (dir: string): Promise<void> => {
  await mkdir(dir);
};

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

/** System folders Explorer hides (lower case, Windows only); besides every name starting with `.`. */
const HIDDEN_NAMES: ReadonlySet<string> = new Set([
  '$recycle.bin',
  'system volume information',
  '$winreagent',
  'recovery',
  'config.msi',
]);

export function isHiddenName(name: string, rules: PathRules = WIN32_PATHS): boolean {
  if (name.startsWith('.')) return true;
  return rules.flavor === 'win32' && HIDDEN_NAMES.has(name.toLowerCase());
}

/** Case-insensitive, then by code point (stable across locales). */
function compareNames(a: FsEntry, b: FsEntry): number {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** `dir` + `name` exactly (one separator in the input's style, the input's spelling kept; POSIX: `/`). */
export function childPath(dir: string, name: string, rules: PathRules = WIN32_PATHS): string {
  if (rules.flavor !== 'win32') return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
  if (/[\\/]$/.test(dir)) return `${dir}${name}`;
  const separator = dir.includes('/') && !dir.includes('\\') ? '/' : '\\';
  return `${dir}${separator}${name}`;
}

/** The folder above `dir`, null at a drive root (POSIX: at `/`). */
export function parentPath(dir: string, rules: PathRules = WIN32_PATHS): string | null {
  const parent = rules.flavor === 'win32' ? path.win32.dirname(dir) : path.posix.dirname(dir);
  return rules.equal(parent, dir) ? null : parent;
}

/** The roots below `/` a POSIX folder browser offers besides the user folder and `/` (WP-103). */
export function posixRootCandidates(userName: string | null): string[] {
  const roots: string[] = [];
  if (userName !== null && pathRules('posix').nameIssue(userName) === null) {
    roots.push(`/media/${userName}`);
  }
  roots.push('/mnt');
  return roots;
}

function currentUserName(): string | null {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
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

/** A failed `mkdir` of `target` in `parent` (`fs.createDirectory`). */
function createError(error: unknown, parent: string, target: string): unknown {
  const code = fsErrorCode(error);
  if (code === 'EEXIST') return new CommandError(makeError('FOLDER_EXISTS', { path: target }));
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new CommandError(makeError('FOLDER_NOT_WRITABLE', { path: parent }));
  }
  return folderError(error, parent);
}

/**
 * A link entry of a listing: the whole path checked (R4-10: a relative target resolves against the
 * folder the link physically lies in, also when the listed folder is reached through a link); true
 * only for a safe link to a folder.
 */
async function isSafeFolderLink(fs: DirFs, link: string, rules: PathRules): Promise<boolean> {
  try {
    await assertNoUnsafeLink(link, fs, rules);
    return (await fs.stat(link)).isDirectory();
  } catch {
    return false;
  }
}

/** Creates the handler of `fs.listDirectory` and `fs.createDirectory` (see the file comment). */
export function createFsCommands(deps: FsCommandsDeps = {}): HostCommandHandler {
  const fs = deps.fs ?? nodeDirFs;
  const makeDir = deps.mkdir ?? nodeMkdir;
  const platform = deps.platform ?? process.platform;
  const rules = pathRules(pathFlavorOf(platform));
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
    if (home !== '' && rules.issue(home) === null) {
      entries.push({ name: rules.baseName(home) || home, path: home, kind: 'home', hidden: false });
    }
    if (platform === 'win32') {
      const present = await Promise.all(DRIVE_ROOTS.map((root) => driveAnswers(root)));
      DRIVE_ROOTS.forEach((root, i) => {
        if (present[i] === true) {
          entries.push({ name: root.slice(0, 2), path: root, kind: 'drive', hidden: false });
        }
      });
    } else {
      entries.push({ name: '/', path: '/', kind: 'drive', hidden: false });
      const candidates = posixRootCandidates(deps.userName ?? currentUserName());
      const present = await Promise.all(candidates.map((root) => driveAnswers(root)));
      candidates.forEach((root, i) => {
        if (present[i] === true) entries.push({ name: root, path: root, kind: 'drive', hidden: false });
      });
    }
    return { path: null, parent: null, entries, truncated: false };
  };

  const list = async (dir: string, showHidden: boolean): Promise<FsListing> => {
    assertSafePath(dir, rules);
    let raw: DirEntry[];
    try {
      await assertNoUnsafeLink(dir, fs, rules);
      if (!(await fs.stat(dir)).isDirectory()) throw new CommandError(makeError('CWD_NOT_DIRECTORY'));
      raw = await fs.readdir(dir);
    } catch (error) {
      throw folderError(error, dir);
    }
    const candidates = raw.filter((entry) => showHidden || !isHiddenName(entry.name, rules));
    const found = await Promise.all(
      candidates.map(async (entry): Promise<FsEntry | null> => {
        const entryPath = childPath(dir, entry.name, rules);
        const hidden = isHiddenName(entry.name, rules);
        if (entry.isSymbolicLink()) {
          return (await isSafeFolderLink(fs, entryPath, rules))
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
      parent: parentPath(dir, rules),
      entries: truncated ? entries.slice(0, LIMITS.fsListMax) : entries,
      truncated,
    };
  };

  const create = async (parent: string, folderName: string): Promise<{ path: string }> => {
    assertSafePath(parent, rules);
    const issue = rules.nameIssue(folderName);
    if (issue !== null) throw new CommandError(makeError('PATH_REJECTED', { reason: issue }));
    const target = childPath(parent, folderName, rules);
    assertSafePath(target, rules);
    // Every later command takes at most LIMITS.pathChars (listing it, session.create).
    if (target.length > LIMITS.pathChars) {
      throw new CommandError(makeError('PATH_REJECTED', { reason: 'too_long' }));
    }
    try {
      await assertNoUnsafeLink(parent, fs, rules);
      if (!(await fs.stat(parent)).isDirectory()) throw new CommandError(makeError('CWD_NOT_DIRECTORY'));
    } catch (error) {
      throw folderError(error, parent);
    }
    try {
      await makeDir(target);
    } catch (error) {
      throw createError(error, parent, target);
    }
    return { path: target };
  };

  const names: readonly HostCommandName[] = ['fs.listDirectory', 'fs.createDirectory'];
  return {
    names,
    handle: (cmd: HostCommand) => {
      if (cmd.name === 'fs.listDirectory') {
        return cmd.path === null ? roots() : list(cmd.path, cmd.showHidden);
      }
      if (cmd.name === 'fs.createDirectory') return create(cmd.parent, cmd.folderName);
      return Promise.reject(new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name })));
    },
  };
}
