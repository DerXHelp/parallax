/**
 * Session file index (ADR-145): which files the tool calls of an entry read or changed –
 * "Dateien dieser Session" and at the same time the access list "session" of ADR-141.
 *
 * - Fed by `observe` (the tap of SessionPublisher.publishOps, WP-60 calls it BEFORE publishing):
 *   `item.upsert` of a `tool_call` with status `done` – `Read` → `read`, `Write` → `written`,
 *   `Edit`/`MultiEdit`/`NotebookEdit` → `edited` (input `file_path` / `notebook_path`),
 *   `ExitPlanMode` input `planFilePath` → `plan` – and `task.outputFile` → `output` (any status: a
 *   running background task's output is meant to be opened), also from `task_notification` system
 *   items; only CLI task data (`…\tasks\<taskId>.output`, ADR-152 – the normalizer takes a task
 *   notification text only with the CLI's origin). Subagent items (`parentToolUseId`) count like any
 *   other. Only absolute paths that pass the string filter; Grep/Glob/Bash on purpose not. Tool
 *   inputs are read tolerantly with zod.
 * - Stored in `entries/<entryId>/files.json` (`sessionFilesFileSchema`, JsonStore: atomic, `.bak`,
 *   quarantine), debounced 2 s, at most LIMITS.sessionFilesMax entries (oldest `lastAt` dropped).
 * - Missing file (or `backfilled: false`): the first use builds the index once from the transcript
 *   logs of all conversations, then `backfilled: true`.
 * - One tool call counts once: the same op of the same tool call is ignored (in-process set), and
 *   `count`/`lastAt` move only for a newer `at` (items re-published after a restart, e.g. the tail
 *   of an earlier conversation, never count twice).
 */
import path from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { LIMITS, type ConversationId, type EntryId } from '@shared/common';
import {
  SESSION_FILES_SCHEMA_VERSION,
  sessionFilesFileSchema,
  type SessionFile,
  type SessionFileOp,
  type SessionFilesFile,
  type TranscriptItem,
} from '@shared/model';
import { windowsPathIssue, windowsPathKey } from '@shared/paths';
import type { SessionOp } from '@shared/protocol';
import { logger as rootLogger } from '../lib/logger';
import { entryDir } from '../store/decisions';
import { JsonStore, type StoreFs, type StoreWarningSink } from '../store/jsonStore';
import type { TranscriptStore } from '../sync/ports';
import type { FileEntryLookup } from './ports';

export const SESSION_FILES_FILE = 'files.json';
/** Write delay of files.json (ADR-145). */
export const SESSION_INDEX_DEBOUNCE_MS = 2_000;
/** Items per transcript read of the backfill. */
const BACKFILL_PAGE = 2_000;
/** Remembered (op, tool call) pairs per entry. */
const SEEN_MAX = 20_000;

/** Tools whose finished call changes a file (also drops the project list cache, ADR-151). */
export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** One file reference found in a transcript item. */
export interface IndexRecord {
  path: string;
  op: SessionFileOp;
  at: string;
  toolUseId: string | null;
  /** Same op of the same tool call/task → counted once. */
  dedupeKey: string;
}

const filePathInput = z.object({ file_path: z.string() });
const notebookPathInput = z.object({ notebook_path: z.string() });
const planFileInput = z.object({ planFilePath: z.string() });

interface ToolInputRule {
  op: SessionFileOp;
  read: (input: unknown) => string | null;
}

const fromFilePath = (input: unknown): string | null => {
  const parsed = filePathInput.safeParse(input);
  return parsed.success ? parsed.data.file_path : null;
};

const TOOL_RULES: Readonly<Record<string, ToolInputRule>> = {
  Read: { op: 'read', read: fromFilePath },
  Write: { op: 'written', read: fromFilePath },
  Edit: { op: 'edited', read: fromFilePath },
  MultiEdit: { op: 'edited', read: fromFilePath },
  NotebookEdit: {
    op: 'edited',
    read: (input) => {
      const parsed = notebookPathInput.safeParse(input);
      return parsed.success ? parsed.data.notebook_path : null;
    },
  },
  ExitPlanMode: {
    op: 'plan',
    read: (input) => {
      const parsed = planFileInput.safeParse(input);
      return parsed.success ? parsed.data.planFilePath : null;
    },
  },
};

/** Absolute, safe and not absurdly long (commands accept at most LIMITS.pathChars). */
function usablePath(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length <= LIMITS.pathChars && windowsPathIssue(value) === null;
}

/**
 * ADR-152 (defense in depth behind the normalizer): an `output` entry only for the shape of the
 * CLI's task data – the CLI writes a task's output to `…\tasks\<taskId>.output`
 * (`%TEMP%\claude\<hash>\<sessionId>\tasks\`, CLI 2.1.322, Agent and Bash tasks alike; the fake
 * `<home>\fake-files\<sessionId>\tasks\`). Any other `outputFile` did not come from the CLI and
 * never enters the access list – also from transcripts written before ADR-152.
 */
export function isTaskOutputFile(file: string, taskId: string): boolean {
  const segments = windowsPathKey(file).split('\\');
  return segments.at(-2) === 'tasks' && segments.at(-1) === `${taskId}.output`.toLowerCase();
}

function usableOutputFile(value: string | null | undefined, taskId: string): value is string {
  return usablePath(value) && isTaskOutputFile(value, taskId);
}

/** File references of one transcript item (pure; see the file comment). */
export function recordsOfItem(item: TranscriptItem): IndexRecord[] {
  if (item.kind === 'system') {
    if (item.event !== 'task_notification' || !usableOutputFile(item.task.outputFile, item.task.taskId)) return [];
    return [
      {
        path: item.task.outputFile,
        op: 'output',
        at: item.at,
        toolUseId: null,
        dedupeKey: `output:task:${item.task.taskId}`,
      },
    ];
  }
  if (item.kind !== 'tool_call') return [];
  const records: IndexRecord[] = [];
  const outputFile = item.task?.outputFile;
  if (item.task !== null && usableOutputFile(outputFile, item.task.taskId)) {
    records.push({
      path: outputFile,
      op: 'output',
      at: item.at,
      toolUseId: item.toolUseId,
      dedupeKey: `output:${item.toolUseId}`,
    });
  }
  const rule = TOOL_RULES[item.toolName];
  if (item.status === 'done' && rule !== undefined) {
    const file = rule.read(item.input);
    if (usablePath(file)) {
      records.push({
        path: file,
        op: rule.op,
        at: item.at,
        toolUseId: item.toolUseId,
        dedupeKey: `${rule.op}:${item.toolUseId}`,
      });
    }
  }
  return records;
}

function time(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Newest `lastAt` first (ties: path key, stable output). */
export function byLastAtDesc(a: SessionFile, b: SessionFile): number {
  const diff = time(b.lastAt) - time(a.lastAt);
  if (diff !== 0) return diff;
  const ka = windowsPathKey(a.path);
  const kb = windowsPathKey(b.path);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export interface SessionIndexDeps {
  home: string;
  entries: FileEntryLookup;
  transcripts: TranscriptStore;
  /** files.json write delay (default SESSION_INDEX_DEBOUNCE_MS). */
  debounceMs?: number;
  /** Store seam (atomic writes of files.json). */
  storeFs?: StoreFs;
  warnings?: StoreWarningSink;
  logger?: Logger;
}

export interface ObserveResult {
  /** A finished Write/Edit/MultiEdit/NotebookEdit was among the ops. */
  wroteFiles: boolean;
}

export interface SessionIndex {
  /** Sync tap; never throws. */
  observe(entryId: EntryId, ops: readonly SessionOp[]): ObserveResult;
  /** Index keys of the entry (after load and backfill). */
  keys(entryId: EntryId): Promise<Pick<ReadonlySet<string>, 'has'>>;
  /** Index entries, newest `lastAt` first. */
  list(entryId: EntryId): Promise<SessionFile[]>;
  flush(): Promise<void>;
}

interface EntryIndex {
  files: Map<string, SessionFile>;
  backfilled: boolean;
  seen: Set<string>;
  conversationId: ConversationId | null;
  store: JsonStore<SessionFilesFile>;
  /** False when files.json could not be loaded (newer schema, read error): memory only. */
  writable: boolean;
  ready: Promise<void>;
}

export function createSessionIndex(deps: SessionIndexDeps): SessionIndex {
  const log = (deps.logger ?? rootLogger).child({ module: 'files.index' });
  const states = new Map<EntryId, EntryIndex>();

  const remember = (state: EntryIndex, key: string): void => {
    state.seen.add(key);
    if (state.seen.size > SEEN_MAX) {
      const oldest = state.seen.values().next();
      if (oldest.done !== true) state.seen.delete(oldest.value);
    }
  };

  /** Merges one record; true if the index changed. */
  const apply = (state: EntryIndex, record: IndexRecord, conversationId: ConversationId | null): boolean => {
    if (state.seen.has(record.dedupeKey)) return false;
    remember(state, record.dedupeKey);
    const key = windowsPathKey(record.path);
    const existing = state.files.get(key);
    if (existing === undefined) {
      state.files.set(key, {
        path: record.path,
        ops: [record.op],
        count: 1,
        firstAt: record.at,
        lastAt: record.at,
        lastToolUseId: record.toolUseId,
        conversationId,
      });
      return true;
    }
    const newer = time(record.at) > time(existing.lastAt);
    const hasOp = existing.ops.includes(record.op);
    if (!newer && hasOp && time(record.at) >= time(existing.firstAt)) return false;
    state.files.set(key, {
      ...existing,
      ops: hasOp ? existing.ops : [...existing.ops, record.op],
      count: newer ? existing.count + 1 : existing.count,
      firstAt: time(record.at) < time(existing.firstAt) ? record.at : existing.firstAt,
      lastAt: newer ? record.at : existing.lastAt,
      lastToolUseId: newer ? record.toolUseId : existing.lastToolUseId,
      conversationId: newer ? conversationId : existing.conversationId,
    });
    return true;
  };

  /** Keeps the newest LIMITS.sessionFilesMax entries. */
  const cap = (state: EntryIndex): void => {
    if (state.files.size <= LIMITS.sessionFilesMax) return;
    const keep = [...state.files.entries()]
      .sort(([, a], [, b]) => byLastAtDesc(a, b))
      .slice(0, LIMITS.sessionFilesMax);
    state.files = new Map(keep);
  };

  const persist = (state: EntryIndex): void => {
    if (!state.writable) return;
    try {
      state.store.set({
        schemaVersion: SESSION_FILES_SCHEMA_VERSION,
        backfilled: state.backfilled,
        files: [...state.files.values()].sort(byLastAtDesc),
      });
    } catch (error) {
      log.error({ err: error }, 'files.json: update failed');
    }
  };

  /** Every item of a conversation, oldest first. */
  const readConversation = async (
    entryId: EntryId,
    conversationId: ConversationId,
  ): Promise<TranscriptItem[]> => {
    let page = await deps.transcripts.readTail(entryId, conversationId, BACKFILL_PAGE);
    const pages: TranscriptItem[][] = [page.items];
    while (page.hasEarlier) {
      const first = page.items[0];
      if (first === undefined) break;
      page = await deps.transcripts.readBefore(entryId, conversationId, first.order, BACKFILL_PAGE);
      pages.unshift(page.items);
    }
    return pages.flat();
  };

  const backfill = async (entryId: EntryId, state: EntryIndex): Promise<void> => {
    const info = deps.entries.entry(entryId);
    if (info === null) return;
    let records = 0;
    for (const conversationId of info.conversationIds) {
      try {
        for (const item of await readConversation(entryId, conversationId)) {
          for (const record of recordsOfItem(item)) {
            if (apply(state, record, conversationId)) records += 1;
          }
        }
      } catch (error) {
        log.warn(
          { err: error, entryId, conversationId },
          'files index: transcript not readable for the backfill',
        );
      }
    }
    state.backfilled = true;
    cap(state);
    persist(state);
    log.debug({ entryId, files: state.files.size, records }, 'files index: backfilled');
  };

  const load = async (entryId: EntryId, state: EntryIndex): Promise<void> => {
    try {
      const file = await state.store.load();
      for (const entry of file.files) {
        // Live records wait for `ready`, so the map is empty here; a duplicate key keeps the first.
        const key = windowsPathKey(entry.path);
        if (!state.files.has(key)) state.files.set(key, entry);
      }
      state.backfilled = file.backfilled;
    } catch (error) {
      state.writable = false;
      log.warn({ err: error, entryId }, 'files index: files.json not usable – index kept in memory only');
    }
    if (!state.backfilled) await backfill(entryId, state);
  };

  const stateFor = (entryId: EntryId): EntryIndex => {
    const known = states.get(entryId);
    if (known !== undefined) return known;
    const store = new JsonStore<SessionFilesFile>({
      file: path.join(entryDir(deps.home, entryId), SESSION_FILES_FILE),
      schema: sessionFilesFileSchema,
      version: SESSION_FILES_SCHEMA_VERSION,
      defaults: () => ({ schemaVersion: SESSION_FILES_SCHEMA_VERSION, backfilled: false, files: [] }),
      debounceMs: deps.debounceMs ?? SESSION_INDEX_DEBOUNCE_MS,
      warnings: deps.warnings,
      fs: deps.storeFs,
      logger: deps.logger,
    });
    const created: EntryIndex = {
      files: new Map(),
      backfilled: false,
      seen: new Set(),
      conversationId: deps.entries.entry(entryId)?.conversationIds.at(-1) ?? null,
      store,
      writable: true,
      ready: Promise.resolve(),
    };
    created.ready = load(entryId, created).catch((error: unknown) => {
      log.error({ err: error, entryId }, 'files index: load failed');
    });
    states.set(entryId, created);
    return created;
  };

  return {
    observe: (entryId, ops) => {
      let wroteFiles = false;
      try {
        const pending: { record: IndexRecord; conversationId: ConversationId | null }[] = [];
        let state: EntryIndex | null = null;
        for (const op of ops) {
          if (op.op === 'conversation.reset') {
            state ??= stateFor(entryId);
            state.conversationId = op.conversationId;
            continue;
          }
          if (op.op !== 'item.upsert') continue;
          const item = op.item;
          if (item.kind === 'tool_call' && item.status === 'done' && FILE_WRITE_TOOLS.has(item.toolName)) {
            wroteFiles = true;
          }
          const records = recordsOfItem(item);
          if (records.length === 0) continue;
          state ??= stateFor(entryId);
          for (const record of records) pending.push({ record, conversationId: state.conversationId });
        }
        if (state !== null && pending.length > 0) {
          const target = state;
          void target.ready
            .then(() => {
              let changed = false;
              for (const { record, conversationId } of pending) {
                if (apply(target, record, conversationId)) changed = true;
              }
              if (!changed) return;
              cap(target);
              persist(target);
            })
            .catch((error: unknown) => {
              log.error({ err: error, entryId }, 'files index: update failed');
            });
        }
      } catch (error) {
        log.error({ err: error, entryId }, 'files index: observe failed');
      }
      return { wroteFiles };
    },
    keys: async (entryId) => {
      const state = stateFor(entryId);
      await state.ready;
      return { has: (key: string) => state.files.has(key) };
    },
    list: async (entryId) => {
      const state = stateFor(entryId);
      await state.ready;
      return [...state.files.values()].sort(byLastAtDesc);
    },
    flush: async () => {
      const all = [...states.values()];
      // Applies queued by `observe` hang on `ready` and run before this continuation.
      await Promise.all(all.map((state) => state.ready));
      await Promise.all(all.filter((state) => state.writable).map((state) => state.store.flush()));
    },
  };
}
