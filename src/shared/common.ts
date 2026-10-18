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

// ---- Tolerant reading of SDK enums (R0-05: a newer CLI may report values we do not know) ----

/** Known permission mode or null (unknown value from a newer CLI → null + unknownEnumCountKey). */
export function parsePermissionMode(value: unknown): PermissionMode | null {
  const parsed = permissionModeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Known effort level or null. */
export function parseEffortLevel(value: unknown): EffortLevel | null {
  const parsed = effortLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Known effort levels in their given order, unknown values and duplicates dropped. */
export function parseEffortLevels(values: readonly unknown[]): EffortLevel[] {
  const result: EffortLevel[] = [];
  for (const value of values) {
    const level = parseEffortLevel(value);
    if (level !== null && !result.includes(level)) result.push(level);
  }
  return result;
}

/** Key in `SessionDetail.unknownCounts` for an unknown enum value, e.g. `enum/permissionMode:turbo`. */
export function unknownEnumCountKey(enumName: 'permissionMode' | 'effort', value: string): string {
  return `enum/${enumName}:${value.slice(0, 100)}`;
}

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
  // ---- R0-08: client input fields (zod `.max()` at the boundary, C.11) ----
  /** Model name in commands (`session.create`, `session.setModel`); long enough for Bedrock ARNs. */
  modelChars: 200,
  /** `plan approve.editedPlan`. */
  planChars: 200_000,
  /** One answer text (`selected` label, `otherText`, `notes`). */
  answerChars: 10_000,
  /** Message of a decision answer: permission `deny.message`, question `decline.message` (R2W-12). */
  decisionMessageChars: 10_000,
  /** Plan feedback `revise.feedback` (R2W-12). */
  planFeedbackChars: 50_000,
  /** `answers[].question` (key = question text, F.5). */
  questionChars: 2_000,
  /** Answers per question response. */
  answersMax: 20,
  /** Selected labels per answer. */
  selectedMax: 50,
  /** `hello.buildId` / `clientHello.buildId` / health. */
  buildIdChars: 100,
  // ---- R0-11: size budget per item and per snapshot (B "Speicher und Performance") ----
  /**
   * Budget per transcript item: chars of its JSON serialization. Assistant text and plan text are
   * exempt (never capped). Over budget, the normalizer moves more content into blobs in this
   * order: `result.structured` → result text parts → input strings (docs/architecture.md §6).
   */
  itemTotalChars: 64 * 1024,
  /** Budget of the `items` of one `session.snapshot` (JSON chars); the hub drops the oldest (hasEarlier). */
  snapshotMaxChars: 2 * 1024 * 1024,
  // ---- Phase 2 (WP-30 §4.2) ----
  /** Raw bytes of one image attachment: base64 ≈ 5 MB (API limit per image; C.11, ADR-103). */
  imageBytes: 3_750_000,
  /** Long edge the client scales images to before the upload (Plan "Anhänge": 1568–2000 px). */
  imageMaxEdgePx: 1568,
  /** Attachments per prompt (promptInputSchema). */
  attachmentsMax: 20,
  /**
   * Raw bytes of all image attachments of one prompt (ADR-125): base64 ≈ 26.7 MB, below the
   * request limit of the Messages API. Over it → `PAYLOAD_TOO_LARGE {bytes, max}`.
   */
  attachmentsTotalBytes: 20_000_000,
  /** Directories of one fs.listDirectory answer; more → `truncated` (ADR-119). */
  fsListMax: 2000,
  /** Path arguments of commands (fs.listDirectory, profile paths) – like session.create.cwd. */
  pathChars: 1000,
  /** Profile input (profile.save / profile.validate; R0-08 "limits at the boundary"). */
  profileEnvMax: 100,
  profileEnvKeyChars: 200,
  profileEnvValueChars: 10_000,
  profileArgsMax: 100,
  profileArgChars: 4_000,
} as const;

/**
 * Model name or alias as given by the user/profile ('haiku', 'claude-opus-5-5', 'sonnet[1m]',
 * Bedrock/Vertex ids). No leading `-` (would look like a CLI flag), no whitespace (R0-09).
 */
export const modelNameSchema = z
  .string()
  .min(1)
  .max(LIMITS.modelChars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~[\]-]*$/);
export type ModelName = z.infer<typeof modelNameSchema>;
