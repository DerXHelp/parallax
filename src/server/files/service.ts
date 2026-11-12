/**
 * The file service (Phase 3, WP-53; port files/ports.ts, ADR-140 … ADR-146, ADR-151): host commands
 * `file.stat`, `file.statMany`, `file.open`, `files.session`, `files.project`, `editor.detect`,
 * GET /api/file (`open`) and the index tap (`observeOps`).
 *
 * Every user path goes through ONE check (`resolveAllowedPath`, lib/paths.ts) with the policy of the
 * entry: roots `cwd`, profile `additionalDirectories` and the attachments folder, plus the session
 * file index (files/sessionIndex.ts). A rejected string never reaches the file system (L15); every
 * fs call has the 3 s timeout of ADR-141 (`guardFileFs`). The physical paths of the roots are cached
 * per entry (60 s; a changed cwd/add-dir list drops them at once). Programs start only through the
 * `ProgramLauncher` seam (files/open.ts). Nothing of a file's content is ever logged.
 */
import path from 'node:path';
import type { Logger } from 'pino';
import { LIMITS, type EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import {
  isDefaultProgramAllowed,
  type FileAccess,
  type FileInfo,
  type FileStatResult,
  type SessionFile,
  type Settings,
} from '@shared/model';
import { windowsPathKey } from '@shared/paths';
import type { CommandOf, CommandResult, HostCommand, HostCommandName, SessionOp } from '@shared/protocol';
import { createFsCallGuard } from '../lib/fsTimeout';
import { logger as rootLogger } from '../lib/logger';
import {
  assertNoUnsafeLink,
  assertSafePath,
  fileAccessError,
  fsErrorCode,
  physicalRoot,
  resolveAllowedPath,
  type AccessPolicy,
} from '../lib/paths';
import { mapPool } from '../lib/pool';
import { runFile, type RunFileFn } from '../lib/process';
import { resolveExecutable } from '../lib/windows';
import { attachmentsDir } from '../store/attachments';
import type { StoreFs, StoreWarningSink } from '../store/jsonStore';
import { CommandError, type TranscriptStore } from '../sync/ports';
import { openContent } from './content';
import { guardFileFs, nodeFileFs, type FileFs } from './fileFs';
import { createRecordingOpener, type ProgramLauncher } from './open';
import type { FileContent, FileEntryInfo, FileEntryLookup, FileService } from './ports';
import { createProjectFiles } from './projectFiles';
import { createSessionIndex, byLastAtDesc } from './sessionIndex';
import { createTruncationCache, statAllowed, type AllowedFile, type StatOptions } from './stat';

/** The commands of this handler (disjoint from the profile store and the folder browser). */
export const FILE_COMMAND_NAMES = [
  'file.stat',
  'file.statMany',
  'file.open',
  'files.session',
  'files.project',
  'editor.detect',
] as const satisfies readonly HostCommandName[];

/** Paths stat'ed at once by `file.statMany` (ADR-142). */
export const FILE_STAT_PARALLEL = 8;
/** Lifetime of the cached physical root paths of an entry (ADR-141). */
export const ROOT_CACHE_MS = 60_000;

export interface FileServiceDeps {
  home: string;
  entries: FileEntryLookup;
  transcripts: TranscriptStore;
  /** Current settings (`editor` of `file.open` / `editor.detect`). */
  settings: () => Settings;
  /**
   * Program start (`file.open`, `editor.detect`). Default: the recording fake (starts nothing) –
   * WP-60 passes `createSystemLauncher()` for the real backend only.
   */
  launcher?: ProgramLauncher;
  /** File system seam (counted in tests); always wrapped with the timeout guard. */
  fs?: FileFs;
  /** Timeout per fs call (default FS_CALL_TIMEOUT_MS = 3 s). */
  fsTimeoutMs?: number;
  /** files.json store seam. */
  storeFs?: StoreFs;
  warnings?: StoreWarningSink;
  /** files.json write delay (default 2 s). */
  indexDebounceMs?: number;
  git?: {
    /** Absolute git.exe or null (default `resolveExecutable('git', process.env)`). */
    resolve?: () => Promise<string | null>;
    run?: RunFileFn;
    env?: Record<string, string>;
  };
  now?: () => number;
  logger?: Logger;
}

interface RootCache {
  signature: string;
  at: number;
  physical: Map<string, string>;
}

function rootsSignature(entry: FileEntryInfo): string {
  return JSON.stringify([entry.cwd, ...entry.additionalDirectories]);
}

function toIso(ms: number): string {
  return new Date(Number.isFinite(ms) && ms > 0 ? ms : 0).toISOString();
}

export function createFileService(deps: FileServiceDeps): FileService {
  const log = (deps.logger ?? rootLogger).child({ module: 'files' });
  const now = deps.now ?? (() => Date.now());
  const fs = guardFileFs(deps.fs ?? nodeFileFs, createFsCallGuard({ timeoutMs: deps.fsTimeoutMs }));
  const launcher = deps.launcher ?? createRecordingOpener({ logger: deps.logger });
  const index = createSessionIndex({
    home: deps.home,
    entries: deps.entries,
    transcripts: deps.transcripts,
    debounceMs: deps.indexDebounceMs,
    storeFs: deps.storeFs,
    warnings: deps.warnings,
    logger: deps.logger,
  });
  const projectFiles = createProjectFiles({
    fs,
    resolveGit: deps.git?.resolve ?? (() => resolveExecutable('git', process.env)),
    run: deps.git?.run ?? runFile,
    env: deps.git?.env,
    now,
  });
  const rootCaches = new Map<EntryId, RootCache>();
  const truncationCache = createTruncationCache();

  const requireEntry = (entryId: EntryId): FileEntryInfo => {
    const entry = deps.entries.entry(entryId);
    if (entry === null) throw new CommandError(makeError('ENTRY_NOT_FOUND'));
    return entry;
  };

  /** Physical root paths, cached per entry; a missing root is asked again next time. */
  const rootResolver = (
    entryId: EntryId,
    entry: FileEntryInfo,
  ): ((root: string) => Promise<string | null>) => {
    const signature = rootsSignature(entry);
    let cache = rootCaches.get(entryId);
    if (cache?.signature !== signature || now() - cache.at >= ROOT_CACHE_MS) {
      cache = { signature, at: now(), physical: new Map() };
      rootCaches.set(entryId, cache);
    }
    const current = cache;
    return async (root) => {
      const cached = current.physical.get(root);
      if (cached !== undefined) return cached;
      const physical = await physicalRoot(root, fs);
      if (physical !== null) current.physical.set(root, physical);
      return physical;
    };
  };

  const policyOf = (entryId: EntryId, entry: FileEntryInfo): AccessPolicy<FileAccess> => ({
    roots: [
      { path: entry.cwd, kind: 'cwd' },
      ...entry.additionalDirectories.map((dir) => ({ path: dir, kind: 'additional' as const })),
      { path: attachmentsDir(deps.home, entryId), kind: 'attachments' },
    ],
    listed: { kind: 'session', keys: () => index.keys(entryId) },
  });

  /** THE check of every path (commands, HTTP, open). */
  const allow = async (entryId: EntryId, entry: FileEntryInfo, file: string): Promise<AllowedFile> => {
    const allowed = await resolveAllowedPath(file, policyOf(entryId, entry), {
      fs,
      resolveRoot: rootResolver(entryId, entry),
    });
    return { path: file, realPath: allowed.realPath, access: allowed.access };
  };

  /** `truncated`: exact for the commands (cached per file version, CR3-04); GET /api/file skips it. */
  const statFile = async (
    entryId: EntryId,
    entry: FileEntryInfo,
    file: string,
    truncation: StatOptions['truncation'] = truncationCache,
  ): Promise<FileInfo> => {
    const allowed = await allow(entryId, entry, file);
    try {
      return await statAllowed(fs, allowed, { truncation });
    } catch (error) {
      throw fileAccessError(error);
    }
  };

  const statMany = async (cmd: CommandOf<'file.statMany'>): Promise<CommandResult<'file.statMany'>> => {
    const entry = requireEntry(cmd.entryId);
    const paths = cmd.paths.slice(0, LIMITS.fileStatBatchMax);
    const results = await mapPool(paths, FILE_STAT_PARALLEL, async (file): Promise<FileStatResult> => {
      try {
        return { path: file, ok: true, file: await statFile(cmd.entryId, entry, file) };
      } catch (error) {
        if (error instanceof CommandError) return { path: file, ok: false, error: error.error };
        log.error({ err: error, entryId: cmd.entryId }, 'file.statMany: unexpected failure');
        return { path: file, ok: false, error: makeError('INTERNAL_ERROR') };
      }
    });
    return { results };
  };

  /** Files in `<attachments>\<blob16>\<name>` as `attached` (two levels, no links). */
  const attachedFiles = async (entryId: EntryId): Promise<SessionFile[]> => {
    const dir = attachmentsDir(deps.home, entryId);
    const found: SessionFile[] = [];
    let folders;
    try {
      folders = await fs.readdir(dir);
    } catch {
      return found; // no attachments yet (ENOENT) or unreadable
    }
    for (const folder of folders) {
      if (folder.isSymbolicLink() || !folder.isDirectory()) continue;
      const sub = path.win32.join(dir, folder.name);
      let names;
      try {
        names = await fs.readdir(sub);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.isSymbolicLink() || !name.isFile()) continue;
        const file = path.win32.join(sub, name.name);
        if (found.length >= LIMITS.sessionFilesMax) return found;
        let mtimeMs: number;
        try {
          mtimeMs = (await fs.stat(file)).mtimeMs;
        } catch {
          continue;
        }
        const at = toIso(mtimeMs);
        found.push({
          path: file,
          ops: ['attached'],
          count: 1,
          firstAt: at,
          lastAt: at,
          lastToolUseId: null,
          conversationId: null,
        });
      }
    }
    return found;
  };

  const sessionFiles = async (entryId: EntryId): Promise<CommandResult<'files.session'>> => {
    requireEntry(entryId);
    const [indexed, attached] = await Promise.all([index.list(entryId), attachedFiles(entryId)]);
    const byKey = new Map(indexed.map((file) => [windowsPathKey(file.path), file]));
    for (const file of attached) {
      const key = windowsPathKey(file.path);
      const known = byKey.get(key);
      if (known === undefined) {
        byKey.set(key, file);
        continue;
      }
      // Attached first, then read/edited by the session: one row with both ops.
      byKey.set(key, {
        ...known,
        ops: known.ops.includes('attached') ? known.ops : ['attached', ...known.ops],
        count: known.count + 1,
        firstAt: file.firstAt < known.firstAt ? file.firstAt : known.firstAt,
      });
    }
    const files = [...byKey.values()].sort(byLastAtDesc);
    const truncated = files.length > LIMITS.sessionFilesMax;
    return { files: truncated ? files.slice(0, LIMITS.sessionFilesMax) : files, truncated };
  };

  /** The cwd of `files.project`: safe, no unsafe link, an existing folder. */
  const checkProjectCwd = async (cwd: string): Promise<void> => {
    assertSafePath(cwd);
    try {
      await assertNoUnsafeLink(cwd, fs);
      const info = await fs.stat(cwd);
      if (!info.isDirectory()) throw new CommandError(makeError('CWD_NOT_DIRECTORY'));
    } catch (error) {
      if (error instanceof CommandError) throw error;
      const code = fsErrorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new CommandError(makeError('CWD_NOT_FOUND'));
      throw fileAccessError(error);
    }
  };

  const projectList = async (entryId: EntryId): Promise<CommandResult<'files.project'>> => {
    const entry = requireEntry(entryId);
    await checkProjectCwd(entry.cwd);
    return projectFiles.list(entryId, entry.cwd);
  };

  const openFile = async (cmd: CommandOf<'file.open'>): Promise<CommandResult<'file.open'>> => {
    const entry = requireEntry(cmd.entryId);
    const allowed = await allow(cmd.entryId, entry, cmd.path);
    let directory: boolean;
    try {
      directory = (await fs.stat(allowed.realPath)).isDirectory();
    } catch (error) {
      throw fileAccessError(error);
    }
    const editor = deps.settings().editor;
    // Preset `system` = "open with the default program" (ADR-144).
    const target = cmd.target === 'editor' && editor.preset === 'system' ? 'default' : cmd.target;
    if (target !== 'explorer' && directory) {
      throw new CommandError(makeError('VALIDATION_FAILED', { reason: 'directory' }));
    }
    if (
      target === 'default' &&
      !(isDefaultProgramAllowed(cmd.path) && isDefaultProgramAllowed(allowed.realPath))
    ) {
      throw new CommandError(makeError('FILE_TYPE_BLOCKED'));
    }
    await launcher.open({
      target,
      path: cmd.path,
      realPath: allowed.realPath,
      directory,
      line: cmd.line,
      col: cmd.col,
      editor,
    });
    return {};
  };

  const handle = async (cmd: HostCommand): Promise<unknown> => {
    switch (cmd.name) {
      case 'file.stat': {
        const entry = requireEntry(cmd.entryId);
        return { file: await statFile(cmd.entryId, entry, cmd.path) } satisfies CommandResult<'file.stat'>;
      }
      case 'file.statMany':
        return statMany(cmd);
      case 'file.open':
        return openFile(cmd);
      case 'files.session':
        return sessionFiles(cmd.entryId);
      case 'files.project':
        return projectList(cmd.entryId);
      case 'editor.detect':
        return launcher.detect(deps.settings().editor);
      default:
        throw new CommandError(makeError('NOT_IMPLEMENTED'));
    }
  };

  return {
    commands: { names: FILE_COMMAND_NAMES, handle },
    async open(entryId, file): Promise<FileContent> {
      const entry = requireEntry(entryId);
      // The answer carries no `truncated`; reading the text for it would read the file twice.
      const info = await statFile(entryId, entry, file, 'skip');
      try {
        return await openContent(fs, info);
      } catch (error) {
        throw fileAccessError(error);
      }
    },
    observeOps(entryId: EntryId, ops: readonly SessionOp[]): void {
      try {
        const { wroteFiles } = index.observe(entryId, ops);
        if (wroteFiles) projectFiles.invalidate(entryId);
      } catch (error) {
        log.error({ err: error, entryId }, 'files: observeOps failed');
      }
    },
    flush: () => index.flush(),
  };
}
