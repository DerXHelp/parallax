/**
 * Test seams of the file service (WP-53), also for WP-60's composition tests: an in-memory
 * transcript store for the index backfill, a fixed entry lookup, and a counting file system that
 * wraps the real one (L15: a rejected path must leave `calls` empty). Never used in production.
 */
import type { ConversationId, EntryId } from '@shared/common';
import type { TranscriptItem } from '@shared/model';
import type { TranscriptStore } from '../sync/ports';
import { nodeFileFs, type FileDirEntry, type FileFs, type FileStats } from './fileFs';
import type { FileEntryInfo, FileEntryLookup } from './ports';

/** Transcript store with fixed items per conversation (oldest first); `append` is ignored. */
export function fakeTranscripts(
  items: Readonly<Record<string, readonly TranscriptItem[]>> = {},
): TranscriptStore & { reads: string[] } {
  const reads: string[] = [];
  const of = (conversationId: ConversationId): readonly TranscriptItem[] => items[conversationId] ?? [];
  return {
    reads,
    append: () => undefined,
    readTail: (_entryId, conversationId, limit) => {
      reads.push(`tail:${conversationId}`);
      const all = of(conversationId);
      const start = Math.max(0, all.length - limit);
      return Promise.resolve({ items: all.slice(start), hasEarlier: start > 0 });
    },
    readBefore: (_entryId, conversationId, beforeOrder, limit) => {
      reads.push(`before:${conversationId}`);
      const earlier = of(conversationId).filter((item) => item.order < beforeOrder);
      const start = Math.max(0, earlier.length - limit);
      return Promise.resolve({ items: earlier.slice(start), hasEarlier: start > 0 });
    },
    flush: () => Promise.resolve(),
  };
}

/** Entry lookup over a fixed map (unknown ids → null). */
export function entryLookup(entries: Readonly<Record<string, FileEntryInfo>>): FileEntryLookup {
  return { entry: (entryId: EntryId) => entries[entryId] ?? null };
}

/** The real file system with every call recorded as `<op>:<path>`. */
export function countingFileFs(base: FileFs = nodeFileFs): FileFs & { calls: string[] } {
  const calls: string[] = [];
  const record = (op: string, file: string): void => {
    calls.push(`${op}:${file}`);
  };
  return {
    calls,
    lstat: (file) => {
      record('lstat', file);
      return base.lstat(file);
    },
    readlink: (file) => {
      record('readlink', file);
      return base.readlink(file);
    },
    realpath: (file) => {
      record('realpath', file);
      return base.realpath(file);
    },
    stat: (file): Promise<FileStats> => {
      record('stat', file);
      return base.stat(file);
    },
    readHead: (file, length) => {
      record('readHead', file);
      return base.readHead(file, length);
    },
    readWhole: (file, max) => {
      record('readWhole', file);
      return base.readWhole(file, max);
    },
    readdir: (dir): Promise<FileDirEntry[]> => {
      record('readdir', dir);
      return base.readdir(dir);
    },
  };
}
