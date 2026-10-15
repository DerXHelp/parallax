/**
 * In-memory doubles of all store ports (`sync/ports.ts`) for WP-13 and WP-20 tests (WP-13 §3.6).
 * Same rules as the WP-10 file stores: the registry validates with `entrySchema.parse`, the
 * transcript folds by id (last line wins), drops streaming items and checks every line against
 * `transcriptLogLineSchema` (like the file store under Vitest), decisions validate their records,
 * blobs are content-addressed (SHA-256, synchronous). Everything is inspectable.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { BlobId, ConversationId, EntryId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import {
  blobRefSchema,
  decisionRecordSchema,
  entrySchema,
  settingsPatchSchema,
  settingsSchema,
  type BlobRef,
  type DecisionRecord,
  type Entry,
  type HostWarning,
  type Settings,
  type TranscriptItem,
} from '@shared/model';
import { isStreamingItem } from '../../store/transcripts';
import {
  transcriptLogLineSchema,
  type BlobStore,
  type DecisionStore,
  type RegistryStore,
  type SettingsStore,
  type StoreWarnings,
  type TranscriptLogLine,
  type TranscriptStore,
} from '../../sync/ports';

export interface MemoryStoresSeed {
  entries?: readonly Entry[];
  transcripts?: readonly {
    entryId: EntryId;
    conversationId: ConversationId;
    items: readonly TranscriptItem[];
  }[];
  decisions?: readonly { entryId: EntryId; records: readonly DecisionRecord[] }[];
  plans?: readonly { entryId: EntryId; version: number; text: string }[];
  settings?: Settings;
  warnings?: readonly HostWarning[];
}

export interface MemoryStoresOptions {
  /** Delay of readTail/readBefore/decisions.load in ms (loadView race tests); default 0. */
  readDelayMs?: number;
  now?: () => Date;
}

export interface MemoryRegistryStore extends RegistryStore {
  readonly flushes: number;
  readonly upserts: number;
}

export interface MemoryTranscriptStore extends TranscriptStore {
  /** Every accepted line of a conversation, in append order. */
  lines(entryId: EntryId, conversationId: ConversationId): TranscriptLogLine[];
  /** Folded items of a conversation, by order. */
  items(entryId: EntryId, conversationId: ConversationId): TranscriptItem[];
  readonly droppedStreaming: number;
  readonly flushes: number;
  /** Changeable at runtime (race tests). */
  readDelayMs: number;
}

export interface MemoryDecisionStore extends DecisionStore {
  /** The last saved records of an entry (copies). */
  records(entryId: EntryId): DecisionRecord[];
  plan(entryId: EntryId, version: number): string | null;
  readonly saves: number;
  readonly flushes: number;
}

export interface MemoryBlobStore extends BlobStore {
  readonly blobs: ReadonlyMap<BlobId, { data: Uint8Array; ref: BlobRef }>;
}

export interface MemorySettingsStore extends SettingsStore {
  readonly updates: number;
}

export interface MemoryStoreWarnings extends StoreWarnings {
  add(error: ErrorPayload): void;
  /** Called after every new warning (like createStoreWarnings). Returns unsubscribe. */
  onChange(listener: (warnings: HostWarning[]) => void): () => void;
}

export interface MemoryStores {
  registry: MemoryRegistryStore;
  transcripts: MemoryTranscriptStore;
  decisions: MemoryDecisionStore;
  blobs: MemoryBlobStore;
  settings: MemorySettingsStore;
  warnings: MemoryStoreWarnings;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function lowerBound(items: readonly TranscriptItem[], order: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const item = items[mid];
    if (item !== undefined && item.order < order) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function createRegistry(seed: readonly Entry[]): MemoryRegistryStore {
  const entries = new Map<EntryId, Entry>();
  for (const entry of seed) {
    const parsed = entrySchema.parse(entry);
    entries.set(parsed.id, parsed);
  }
  let flushes = 0;
  let upserts = 0;
  return {
    list: () => [...entries.values()].map((entry) => structuredClone(entry)),
    get: (id) => {
      const entry = entries.get(id);
      return entry === undefined ? undefined : structuredClone(entry);
    },
    upsert: (entry) => {
      const parsed = entrySchema.parse(entry);
      entries.set(parsed.id, parsed);
      upserts += 1;
    },
    remove: (id) => {
      entries.delete(id);
    },
    flush: () => {
      flushes += 1;
      return Promise.resolve();
    },
    get flushes() {
      return flushes;
    },
    get upserts() {
      return upserts;
    },
  };
}

function createTranscripts(
  seed: MemoryStoresSeed['transcripts'],
  options: MemoryStoresOptions,
): MemoryTranscriptStore {
  const lines = new Map<string, TranscriptLogLine[]>();
  const key = (entryId: EntryId, conversationId: ConversationId) => `${entryId}/${conversationId}`;
  const at = (options.now ?? (() => new Date()))().toISOString();
  let droppedStreaming = 0;
  let flushes = 0;

  const accept = (entryId: EntryId, conversationId: ConversationId, line: TranscriptLogLine): void => {
    if (line.op === 'upsert' && isStreamingItem(line.item)) {
      droppedStreaming += 1;
      return;
    }
    // Like the file store under Vitest (R1-16): an invalid line is a bug of the writer.
    const parsed = transcriptLogLineSchema.safeParse(line);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `MemoryTranscriptStore: invalid log line – ${issue?.path.map(String).join('.') ?? ''}: ${issue?.message ?? 'invalid'}`,
      );
    }
    const list = lines.get(key(entryId, conversationId)) ?? [];
    list.push(structuredClone(line));
    lines.set(key(entryId, conversationId), list);
  };

  const fold = (entryId: EntryId, conversationId: ConversationId): TranscriptItem[] => {
    const items = new Map<string, TranscriptItem>();
    for (const line of lines.get(key(entryId, conversationId)) ?? []) {
      if (line.op === 'upsert') items.set(line.item.id, line.item);
      else items.delete(line.itemId);
    }
    return [...items.values()].sort((a, b) => a.order - b.order).map((item) => structuredClone(item));
  };

  for (const s of seed ?? []) {
    for (const item of s.items) accept(s.entryId, s.conversationId, { v: 1, at, op: 'upsert', item });
  }

  const store: MemoryTranscriptStore = {
    readDelayMs: options.readDelayMs ?? 0,
    append: (entryId, conversationId, line) => {
      accept(entryId, conversationId, line);
    },
    readTail: async (entryId, conversationId, limit) => {
      if (store.readDelayMs > 0) await sleep(store.readDelayMs);
      const items = fold(entryId, conversationId);
      const start = Math.max(0, items.length - Math.max(0, limit));
      return { items: items.slice(start), hasEarlier: start > 0 };
    },
    readBefore: async (entryId, conversationId, beforeOrder, limit) => {
      if (store.readDelayMs > 0) await sleep(store.readDelayMs);
      const items = fold(entryId, conversationId);
      const end = lowerBound(items, beforeOrder);
      const start = Math.max(0, end - Math.max(0, limit));
      return { items: items.slice(start, end), hasEarlier: start > 0 };
    },
    flush: () => {
      flushes += 1;
      return Promise.resolve();
    },
    lines: (entryId, conversationId) =>
      (lines.get(key(entryId, conversationId)) ?? []).map((l) => structuredClone(l)),
    items: fold,
    get droppedStreaming() {
      return droppedStreaming;
    },
    get flushes() {
      return flushes;
    },
  };
  return store;
}

const recordsSchema = z.array(decisionRecordSchema);

function createDecisions(seed: MemoryStoresSeed, options: MemoryStoresOptions): MemoryDecisionStore {
  const records = new Map<EntryId, DecisionRecord[]>();
  const plans = new Map<string, string>();
  const planKey = (entryId: EntryId, version: number) => `${entryId}/v${String(version)}`;
  let saves = 0;
  let flushes = 0;
  for (const s of seed.decisions ?? [])
    records.set(s.entryId, recordsSchema.parse(structuredClone(s.records)));
  for (const p of seed.plans ?? []) plans.set(planKey(p.entryId, p.version), p.text);

  return {
    load: async (entryId) => {
      if ((options.readDelayMs ?? 0) > 0) await sleep(options.readDelayMs ?? 0);
      return structuredClone(records.get(entryId) ?? []);
    },
    save: (entryId, list) => {
      // Like the JsonStore: the file must be valid and survive parse unchanged (explicit defaults).
      const parsed = recordsSchema.parse(list);
      if (!isDeepStrictEqual(parsed, list))
        throw new Error('MemoryDecisionStore: records change under parse');
      records.set(entryId, structuredClone(parsed));
      saves += 1;
    },
    savePlan: (entryId, version, text) => {
      plans.set(planKey(entryId, version), text);
      return Promise.resolve();
    },
    readPlan: (entryId, version) => Promise.resolve(plans.get(planKey(entryId, version)) ?? null),
    flush: () => {
      flushes += 1;
      return Promise.resolve();
    },
    records: (entryId) => structuredClone(records.get(entryId) ?? []),
    plan: (entryId, version) => plans.get(planKey(entryId, version)) ?? null,
    get saves() {
      return saves;
    },
    get flushes() {
      return flushes;
    },
  };
}

function createBlobs(): MemoryBlobStore {
  const blobs = new Map<BlobId, { data: Uint8Array; ref: BlobRef }>();
  return {
    blobs,
    put: (data, mediaType, name = null) => {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      const blobId = createHash('sha256').update(bytes).digest('hex');
      const known = blobs.get(blobId);
      if (known !== undefined) return known.ref;
      const type = mediaType.trim();
      const ref = blobRefSchema.parse({
        blobId,
        mediaType: type === '' || type.length > 100 ? 'application/octet-stream' : type,
        bytes: bytes.byteLength,
        name: name === null ? null : name.slice(0, 260),
      });
      blobs.set(blobId, { data: new Uint8Array(bytes), ref });
      return ref;
    },
    get: (blobId) => Promise.resolve(blobs.get(blobId) ?? null),
  };
}

function createSettings(seed: Settings | undefined): MemorySettingsStore {
  let settings = settingsSchema.parse(seed ?? {});
  let updates = 0;
  return {
    get: () => settings,
    update: (patch) => {
      const parsed = settingsPatchSchema.parse(patch);
      const entries: [string, unknown][] = Object.entries(parsed);
      const changes = Object.fromEntries(entries.filter(([, value]) => value !== undefined));
      settings = settingsSchema.parse({ ...settings, ...changes });
      updates += 1;
      return settings;
    },
    get updates() {
      return updates;
    },
  };
}

function createWarnings(seed: readonly HostWarning[], options: MemoryStoresOptions): MemoryStoreWarnings {
  const warnings: HostWarning[] = [...seed];
  const listeners = new Set<(warnings: HostWarning[]) => void>();
  const now = options.now ?? (() => new Date());
  return {
    list: () => [...warnings],
    add: (error) => {
      warnings.push({ id: `store-${String(warnings.length + 1)}`, error, at: now().toISOString() });
      for (const listener of listeners) listener([...warnings]);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function createMemoryStores(
  seed: MemoryStoresSeed = {},
  options: MemoryStoresOptions = {},
): MemoryStores {
  return {
    registry: createRegistry(seed.entries ?? []),
    transcripts: createTranscripts(seed.transcripts, options),
    decisions: createDecisions(seed, options),
    blobs: createBlobs(),
    settings: createSettings(seed.settings),
    warnings: createWarnings(seed.warnings ?? [], options),
  };
}
