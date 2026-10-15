/**
 * Port: sync hub / stores (WP-10) ↔ session engine (WP-13). Types only, plus the two runtime
 * exceptions of the ports: `CommandError` and `transcriptLogLineSchema`. Frozen like src/shared.
 * Design: docs/wp/WP-02.md §8.1, §9.5.
 *
 * WP-10 modules (fixed names): http/app.ts (createApp), http/auth.ts (POST /api/auth,
 * GET /api/auth/status, POST /api/launcher/code, device cookie, one-time codes), http/origin.ts
 * (Host/Origin/Sec-Fetch-Site guards) – contract src/shared/http.ts, rules docs/architecture.md
 * §5.1; sync/hub.ts (createSyncHub({source}): SessionPublisher & { attach(app) }),
 * store/jsonStore.ts, store/registry.ts, store/transcripts.ts, store/blobs.ts (meta file
 * `blobs/<blobId>.meta.json` = blobRefSchema, R0-30), store/decisions.ts, store/settings.ts,
 * config.ts, lib/logger.ts, lib/ids.ts (newId(prefix)), lib/paths.ts (fs checks on top of
 * @shared/paths). Test helper: createMemorySessionSource() next to hub.ts.
 * In dev/test mode the hub parses every published op with sessionOpSchema (R0-28).
 */
import { z } from 'zod';
import {
  isoDateTimeSchema,
  itemIdSchema,
  type BlobId,
  type ClientId,
  type ConversationId,
  type EntryId,
} from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import {
  transcriptItemSchema,
  type BlobRef,
  type DecisionRecord,
  type Entry,
  type HostState,
  type HostWarning,
  type SessionSummary,
  type Settings,
  type SettingsPatch,
  type TranscriptItem,
} from '@shared/model';
import type { Command, Notification, PresenceState, SessionOp } from '@shared/protocol';
import type { SessionViewState } from '@shared/sync';

export interface ClientPresence {
  clientId: ClientId;
  presence: PresenceState;
  lastFocusAt: Date | null;
  connectedAt: Date;
}

export interface CommandContext {
  clientId: ClientId;
  cmdId: string;
}

/** Thrown by command handlers; the hub turns it into ack{ok:false}. */
export class CommandError extends Error {
  readonly error: ErrorPayload;

  constructor(error: ErrorPayload) {
    super(error.message ?? error.code);
    this.name = 'CommandError';
    this.error = error;
  }
}

/** Implemented by the WP-10 SyncHub; used by the engine. */
export interface SessionPublisher {
  /** Seq, delta coalescing, ring buffer, view update (applySessionOp), fan-out. */
  publishOps(entryId: EntryId, ops: SessionOp[]): void;
  /** urgent=false → throttled (§7.3). */
  publishSummary(summary: SessionSummary, urgent: boolean): void;
  removeSummary(entryId: EntryId): void;
  publishHostState(host: HostState): void;
  notify(clientId: ClientId, notification: Notification): void;
  clearNotification(entryId: EntryId): void;
  presence(): readonly ClientPresence[];
  /** Shutdown. */
  closeAll(code: number): void;
}

/** Implemented by the WP-13 engine; used by the hub. */
export interface SessionSource {
  hostState(): HostState;
  listSummaries(): SessionSummary[];
  /**
   * Materialized view for an entry without cached state (restart, eviction): log tail + live state.
   * The hub assigns `seq` itself; the `seq` of the returned view is ignored (R0-20).
   */
  loadView(entryId: EntryId): Promise<SessionViewState | null>;
  /** Result matching commandResultSchemas[cmd.name]; throws CommandError. */
  handleCommand(cmd: Command, ctx: CommandContext): Promise<unknown>;
  onPresenceChanged(all: readonly ClientPresence[]): void;
  /** Cache eviction (B). */
  onSubscribersChanged(entryId: EntryId, count: number): void;
}

// ---- Transcript log (one JSON line per persisted op, A.3) ----

export const TRANSCRIPT_LOG_VERSION = 1;

/**
 * One line of `entries/<entryId>/<conversationId>.transcript.jsonl`. Deltas and streaming items
 * are never persisted (live-only, A.3). Loading = fold by id (last line wins), sort by order;
 * broken lines are skipped and counted.
 */
export const transcriptLogLineSchema = z.discriminatedUnion('op', [
  z.object({
    v: z.literal(TRANSCRIPT_LOG_VERSION),
    at: isoDateTimeSchema,
    op: z.literal('upsert'),
    /** Only non-streaming items. */
    item: transcriptItemSchema,
  }),
  z.object({
    v: z.literal(TRANSCRIPT_LOG_VERSION),
    at: isoDateTimeSchema,
    op: z.literal('remove'),
    itemId: itemIdSchema,
  }),
]);
export type TranscriptLogLine = z.infer<typeof transcriptLogLineSchema>;

// ---- Stores (WP-10) ----

export interface TranscriptStore {
  /** Buffered, single writer. */
  append(entryId: EntryId, conversationId: ConversationId, line: TranscriptLogLine): void;
  readTail(
    entryId: EntryId,
    conversationId: ConversationId,
    limit: number,
  ): Promise<{ items: TranscriptItem[]; hasEarlier: boolean }>;
  readBefore(
    entryId: EntryId,
    conversationId: ConversationId,
    beforeOrder: number,
    limit: number,
  ): Promise<{ items: TranscriptItem[]; hasEarlier: boolean }>;
  flush(): Promise<void>;
}

export interface BlobStore {
  put(data: Uint8Array | string, mediaType: string, name?: string | null): BlobRef;
  get(blobId: BlobId): Promise<{ data: Uint8Array; ref: BlobRef } | null>;
}

export interface RegistryStore {
  list(): Entry[];
  get(id: EntryId): Entry | undefined;
  /** Validated, debounced write (B). */
  upsert(entry: Entry): void;
  remove(id: EntryId): void;
  flush(): Promise<void>;
}

export interface DecisionStore {
  load(entryId: EntryId): Promise<DecisionRecord[]>;
  /** Open records carry `decision` (restored as expired after a restart, R0-07); resolved ones null. */
  save(entryId: EntryId, records: DecisionRecord[]): void;
  savePlan(entryId: EntryId, version: number, text: string): Promise<void>;
  readPlan(entryId: EntryId, version: number): Promise<string | null>;
}

export interface SettingsStore {
  get(): Settings;
  /** Only the given fields change. */
  update(patch: SettingsPatch): Settings;
}

/** Quarantine messages (B). */
export interface StoreWarnings {
  list(): HostWarning[];
}
