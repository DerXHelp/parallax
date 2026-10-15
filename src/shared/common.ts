/**
 * Shared building blocks of all contracts: ids, time, JSON values, SDK enums Parallax sends,
 * limits. Import order of the shared modules (no cycles): common → errors → status → model →
 * protocol → sync. Design: docs/wp/WP-02.md §2–§3.
 */
import { z } from 'zod';

// ---- IDs (WP-02 §2.2) ----

/** `<prefix>_` + 32 lower-case hex chars (server-generated ids, see src/server/lib/ids.ts). */
const hex32 = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{32}$`));

/** Sidebar entry; also the folder name under `entries/`. */
export const entryIdSchema = hex32('en');
export type EntryId = z.infer<typeof entryIdSchema>;

/** Parallax conversation; exists before the Claude session id is known (F.7). */
export const conversationIdSchema = hex32('cv');
export type ConversationId = z.infer<typeof conversationIdSchema>;

/** Server id of one decision (permission / question / plan). */
export const decisionIdSchema = hex32('dc');
export type DecisionId = z.infer<typeof decisionIdSchema>;

/** One browser window (kept in sessionStorage). */
export const clientIdSchema = hex32('cl');
export type ClientId = z.infer<typeof clientIdSchema>;

export const STANDARD_PROFILE_ID = 'standard' as const;

/** Built-in profile `standard` or `pf_` + 32 hex. */
export const profileIdSchema = z.union([z.literal(STANDARD_PROFILE_ID), hex32('pf')]);
export type ProfileId = z.infer<typeof profileIdSchema>;

/** Idempotency key of a command (client-generated UUID). */
export const cmdIdSchema = z.uuid();
export type CmdId = z.infer<typeof cmdIdSchema>;

/** `SDKUserMessage.uuid` of a prompt sent by Parallax. */
export const messageUuidSchema = z.uuid();
export type MessageUuid = z.infer<typeof messageUuidSchema>;

/** Content-addressed blob (SHA-256, 64 lower-case hex). */
export const blobIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type BlobId = z.infer<typeof blobIdSchema>;

/** Claude session id from `init.session_id` (no UUID constraint on purpose). */
export const claudeSessionIdSchema = z.string().min(1).max(100);
export type ClaudeSessionId = z.infer<typeof claudeSessionIdSchema>;

/** Transcript item id (schema in WP-02 §5.6). */
export const itemIdSchema = z.string().min(1).max(200);
export type ItemId = z.infer<typeof itemIdSchema>;

/** Client-side host id (never on the wire, never contains `:`). */
export const hostIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
export type HostId = z.infer<typeof hostIdSchema>;

/** Host id of the local server (Phase 1: the only host). */
export const LOCAL_HOST_ID = 'local' as const;

/** Client-side session key `hostId:entryId` (never sent to a server). */
export function makeSessionKey(hostId: HostId, entryId: EntryId): string {
  return `${hostId}:${entryId}`;
}

/** Inverse of makeSessionKey; null for malformed keys (validates both parts). */
export function parseSessionKey(key: string): { hostId: HostId; entryId: EntryId } | null {
  const sep = key.indexOf(':');
  if (sep < 0) return null;
  const hostId = hostIdSchema.safeParse(key.slice(0, sep));
  const entryId = entryIdSchema.safeParse(key.slice(sep + 1));
  if (!hostId.success || !entryId.success) return null;
  return { hostId: hostId.data, entryId: entryId.data };
}

// ---- Time / JSON ----

/** ISO 8601 date-time with offset (`Date.prototype.toISOString()` output). */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

/** Arbitrary JSON (tool input, `tool_use_result`). */
export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

/** Small key/value bag for error/notification parameters (UI interpolation). */
export const paramsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
export type Params = z.infer<typeof paramsSchema>;

export const DECISION_KINDS = ['permission', 'question', 'plan'] as const;
export const decisionKindSchema = z.enum(DECISION_KINDS);
export type DecisionKind = z.infer<typeof decisionKindSchema>;

// ---- SDK enums Parallax sends or decides on (mirrors SDK 0.3.296, F.2/F.12) ----

/** `dontAsk` can be reported by the CLI; the UI does not offer it (WP-16). */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;
export const permissionModeSchema = z.enum(PERMISSION_MODES);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const effortLevelSchema = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

/**
 * Destinations the user may pick for remembered permission rules (ADR-012). The UI default is
 * `session`; `projectSettings` writes into the repo, `userSettings` is global (WP-16 warns).
 * `setMode` always uses `session` (C.4), independent of this choice.
 */
export const RULE_DESTINATIONS = ['session', 'localSettings', 'projectSettings', 'userSettings'] as const;
export const ruleDestinationSchema = z.enum(RULE_DESTINATIONS);
export type RuleDestination = z.infer<typeof ruleDestinationSchema>;

/** `next` = queue (default while a turn runs), `now` = "send now" (interrupts the turn, F.9). */
export const promptPrioritySchema = z.enum(['next', 'now']);
export type PromptPriority = z.infer<typeof promptPrioritySchema>;

export const languageSchema = z.enum(['en', 'de']);
export type Language = z.infer<typeof languageSchema>;

export const themeSchema = z.enum(['dark', 'light', 'system']);
export type Theme = z.infer<typeof themeSchema>;

// ---- Limits (B "Speicher und Performance", C.11) ----

export const LIMITS = {
  /** Cap per text field of an item (tool output, tool input strings, thinking): 48 Ki UTF-16 chars. */
  itemTextChars: 48 * 1024,
  /** Cap for serialized structured tool results (`tool_use_result`), chars of JSON. */
  itemStructuredChars: 48 * 1024,
  /** Items in a subscribe snapshot. */
  snapshotItems: 150,
  /** Max items per transcript.loadEarlier. */
  loadEarlierMax: 200,
  /** Ops kept per entry in the server ring buffer. */
  ringBufferOps: 2000,
  /** Server-side text delta coalescing window (A.2: 30–50 ms). */
  deltaFlushMs: 40,
  /** Min interval of throttled summary updates (A.2: ≤ 1/s). */
  summaryThrottleMs: 1000,
  /** Prompt text length. */
  promptChars: 200_000,
  /** WS maxPayload (C.11); attachments go via HTTP, not WS. */
  wsMaxPayloadBytes: 4 * 1024 * 1024,
  /** Idempotency cache for cmdIds (host-wide LRU). */
  cmdCacheSize: 1000,
  cmdCacheTtlMs: 10 * 60 * 1000,
  /** Title length. */
  titleChars: 200,
} as const;
