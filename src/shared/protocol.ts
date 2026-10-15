/**
 * WebSocket protocol between web UI and server (A.2, A.9, B, C.11). One JSON object per frame,
 * discriminator `type`. On the wire there is only `entryId`, never `hostId`/`sessionKey` (B
 * "Vereinfachungen"). Design (normative): docs/wp/WP-02.md §7; versioning rules §13.
 */
import { z } from 'zod';
import {
  LIMITS,
  blobIdSchema,
  clientIdSchema,
  cmdIdSchema,
  conversationIdSchema,
  decisionIdSchema,
  effortLevelSchema,
  entryIdSchema,
  isoDateTimeSchema,
  itemIdSchema,
  messageUuidSchema,
  modelNameSchema,
  permissionModeSchema,
  profileIdSchema,
  promptPrioritySchema,
} from './common';
import { errorPayloadSchema, makeError, type ErrorPayload } from './errors';
import {
  contextBreakdownSchema,
  decisionOutcomeSchema,
  decisionResponseSchema,
  decisionSchema,
  hostStateSchema,
  modelOptionSchema,
  sessionDetailPatchSchema,
  sessionDetailSchema,
  sessionSummarySchema,
  settingsPatchSchema,
  settingsSchema,
  transcriptItemSchema,
} from './model';
import { notificationKindSchema } from './status';

/** Bump rules: docs/wp/WP-02.md §13 (not for new optional fields, server message types or commands). */
export const PROTOCOL_VERSION = 1;
/**
 * A rejected upgrade (cookie, Origin, Host, Sec-Fetch-Site) is an HTTP 401/403 with an
 * `ErrorPayload` body – the browser only sees close 1006, so the client asks
 * `GET /api/auth/status` before connecting and after an abnormal close (src/shared/http.ts).
 */
export const WS_PATH = '/api/ws';
export const WS_CLOSE = {
  /** Repeated invalid messages / message before clientHello. */
  PROTOCOL_ERROR: 4400,
  /** Cookie secret rotated. */
  AUTH_REVOKED: 4401,
  PROTOCOL_VERSION_MISMATCH: 4409,
  SERVER_SHUTDOWN: 4503,
} as const;

// =====================================================================================
// 7.2 Presence (A.9)
// =====================================================================================

export const presenceStateSchema = z.object({
  /** document.hasFocus() */
  focused: z.boolean(),
  /** visibilityState === 'visible' */
  visible: z.boolean(),
  /** Session shown in this window. */
  viewingEntryId: entryIdSchema.nullable(),
  /** Composer active within the last 5 s (no focus stealing). */
  typing: z.boolean(),
});
export type PresenceState = z.infer<typeof presenceStateSchema>;

/** Sent after every change (debounced 250 ms). */
export const presenceMessageSchema = z.object({ type: z.literal('presence'), presence: presenceStateSchema });

// =====================================================================================
// 7.1 Handshake
// =====================================================================================

export const helloSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int().positive(),
  /** 'dev' in dev mode, otherwise the build id (`BUILD_ID`, src/shared/build.ts). */
  buildId: z.string().min(1).max(LIMITS.buildIdChars),
  /** New on every server start → client full resync. */
  serverInstanceId: z.uuid(),
  serverVersion: z.string(),
  serverStartedAt: isoDateTimeSchema,
});
export type HelloMessage = z.infer<typeof helloSchema>;

export const clientHelloSchema = z.object({
  type: z.literal('clientHello'),
  protocolVersion: z.number().int().positive(),
  buildId: z.string().min(1).max(LIMITS.buildIdChars),
  /** Stable per window (sessionStorage). */
  clientId: clientIdSchema,
  presence: presenceStateSchema,
});
export type ClientHelloMessage = z.infer<typeof clientHelloSchema>;

// =====================================================================================
// 7.3 Channel 1 – host-wide (to all clients); always whole objects, last writer wins per entryId
// =====================================================================================

export const hostStateMessageSchema = z.object({ type: z.literal('host.state'), host: hostStateSchema });
export const summariesSnapshotSchema = z.object({
  type: z.literal('summaries.snapshot'),
  summaries: z.array(sessionSummarySchema),
});
export const summaryUpsertSchema = z.object({
  type: z.literal('summary.upsert'),
  summary: sessionSummarySchema,
});
export const summaryRemoveSchema = z.object({ type: z.literal('summary.remove'), entryId: entryIdSchema });

// =====================================================================================
// 7.4 Channel 2 – session subscription (A.2)
// =====================================================================================

export const subscribeSchema = z.object({
  type: z.literal('subscribe'),
  entryId: entryIdSchema,
  /** Last seen seq; missing = snapshot. */
  sinceSeq: z.number().int().nonnegative().optional(),
});
export const unsubscribeSchema = z.object({ type: z.literal('unsubscribe'), entryId: entryIdSchema });

export const ITEM_DELTA_FIELDS = ['text', 'thinking', 'inputPartial'] as const;

export const sessionOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('item.upsert'), item: transcriptItemSchema }),
  z.object({
    op: z.literal('item.delta'),
    itemId: itemIdSchema,
    field: z.enum(ITEM_DELTA_FIELDS),
    append: z.string(),
  }),
  /** model_refusal_fallback (supersedes/retracted). */
  z.object({ op: z.literal('item.remove'), itemId: itemIdSchema }),
  z.object({
    op: z.literal('conversation.reset'),
    conversationId: conversationIdSchema,
    previousConversationId: conversationIdSchema,
    trigger: z.string().nullable(),
  }),
  /** New, or → expired. */
  z.object({ op: z.literal('decision.upsert'), decision: decisionSchema }),
  /** decisionResolved (A.2). */
  z.object({
    op: z.literal('decision.resolved'),
    decisionId: decisionIdSchema,
    outcome: decisionOutcomeSchema,
    byClientId: clientIdSchema.nullable(),
    at: isoDateTimeSchema,
  }),
  /** Replaces exactly the given fields (no array merge, no defaults). */
  z.object({ op: z.literal('detail.patch'), patch: sessionDetailPatchSchema }),
]);
export type SessionOp = z.infer<typeof sessionOpSchema>;
export type SessionOpName = SessionOp['op'];

export const seqOpSchema = z.object({
  seq: z.number().int().positive(),
  at: isoDateTimeSchema,
  op: sessionOpSchema,
});
export type SeqOp = z.infer<typeof seqOpSchema>;

export const sessionSnapshotSchema = z.object({
  type: z.literal('session.snapshot'),
  entryId: entryIdSchema,
  /** Seq of the last contained state. */
  seq: z.number().int().nonnegative(),
  /** Last ≤ LIMITS.snapshotItems items of the current conversation, by order. */
  items: z.array(transcriptItemSchema),
  hasEarlier: z.boolean(),
  /** Open + expired, by createdAt. */
  decisions: z.array(decisionSchema),
  detail: sessionDetailSchema,
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export const sessionOpsSchema = z.object({
  type: z.literal('session.ops'),
  entryId: entryIdSchema,
  /** Gap-free ascending; empty = replay without new ops. */
  ops: z.array(seqOpSchema),
});
export type SessionOpsMessage = z.infer<typeof sessionOpsSchema>;

/** Subscription rejected (ENTRY_NOT_FOUND …). */
export const sessionUnavailableSchema = z.object({
  type: z.literal('session.unavailable'),
  entryId: entryIdSchema,
  error: errorPayloadSchema,
});

// =====================================================================================
// 7.5 Commands (`cmd`) with `cmdId` and `ack` (A.2)
// =====================================================================================

export const promptInputSchema = z
  .object({
    text: z.string().max(LIMITS.promptChars),
    /** Images/PDF, uploaded via HTTP before (Phase 1: NOT_IMPLEMENTED). */
    attachments: z
      .array(z.object({ blobId: blobIdSchema }))
      .max(20)
      .default([]),
  })
  .refine((p) => p.text.trim() !== '' || p.attachments.length > 0, { message: 'empty prompt' });
export type PromptInput = z.infer<typeof promptInputSchema>;

export const commandSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('session.create'),
    cwd: z.string().min(1).max(1000),
    /** Missing = default profile of the host. */
    profileId: profileIdSchema.optional(),
    title: z.string().max(LIMITS.titleChars).optional(),
    /** Missing = profile default / CLI. */
    model: modelNameSchema.optional(),
    /** Missing = omit (C.3). `bypassPermissions` only if the profile allowsBypass (R0-09). */
    permissionMode: permissionModeSchema.optional(),
    effort: effortLevelSchema.optional(),
    /** First prompt (starts the session). */
    prompt: promptInputSchema.optional(),
  }),
  z.object({
    name: z.literal('session.sendPrompt'),
    entryId: entryIdSchema,
    prompt: promptInputSchema,
    priority: promptPrioritySchema.default('next'),
  }),
  z.object({ name: z.literal('session.interrupt'), entryId: entryIdSchema }),
  /** null = default. */
  z.object({
    name: z.literal('session.setModel'),
    entryId: entryIdSchema,
    model: modelNameSchema.nullable(),
  }),
  z.object({
    name: z.literal('session.setPermissionMode'),
    entryId: entryIdSchema,
    mode: permissionModeSchema,
  }),
  z.object({
    name: z.literal('session.setEffort'),
    entryId: entryIdSchema,
    effort: effortLevelSchema.nullable(),
  }),
  z.object({ name: z.literal('session.setFastMode'), entryId: entryIdSchema, enabled: z.boolean() }),
  /** null = back to the automatic title. */
  z.object({
    name: z.literal('session.rename'),
    entryId: entryIdSchema,
    title: z.string().trim().min(1).max(LIMITS.titleChars).nullable(),
  }),
  /** End the process, keep the entry (→ sleeping). */
  z.object({ name: z.literal('session.close'), entryId: entryIdSchema }),
  /**
   * Start the process via resume (sleeping/interrupted/error). Without a Claude session id
   * (entry created without prompt) → fresh start in the stored cwd (R0-21).
   */
  z.object({ name: z.literal('session.resume'), entryId: entryIdSchema }),
  z.object({ name: z.literal('session.setPinned'), entryId: entryIdSchema, pinned: z.boolean() }),
  z.object({ name: z.literal('session.setArchived'), entryId: entryIdSchema, archived: z.boolean() }),
  z.object({
    name: z.literal('decision.respond'),
    entryId: entryIdSchema,
    decisionId: decisionIdSchema,
    response: decisionResponseSchema,
  }),
  z.object({
    name: z.literal('transcript.loadEarlier'),
    entryId: entryIdSchema,
    conversationId: conversationIdSchema,
    beforeOrder: z.number().int().positive(),
    limit: z.number().int().min(1).max(LIMITS.loadEarlierMax),
  }),
  z.object({
    name: z.literal('session.getContext'),
    entryId: entryIdSchema,
    detail: z.enum(['summary', 'full']),
  }),
  /** supportedModels() → detail.patch */
  z.object({ name: z.literal('session.refreshModels'), entryId: entryIdSchema }),
  /** Only the given fields change (no defaults applied). */
  z.object({ name: z.literal('settings.update'), patch: settingsPatchSchema }),
  z.object({ name: z.literal('server.shutdown') }),
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandName = Command['name'];
/** The command object of one name, e.g. `CommandOf<'decision.respond'>`. */
export type CommandOf<N extends CommandName> = Extract<Command, { name: N }>;

/** Every command is its own message; the server answers exactly once with `ack`. */
export const cmdMessageSchema = z.object({ type: z.literal('cmd'), cmdId: cmdIdSchema, cmd: commandSchema });
export type CmdMessage = z.infer<typeof cmdMessageSchema>;

/** Result schema per command (ack.result is parsed with this on the client). */
export const commandResultSchemas = {
  'session.create': z.object({ entryId: entryIdSchema, messageUuid: messageUuidSchema.nullable() }),
  'session.sendPrompt': z.object({ messageUuid: messageUuidSchema }),
  'session.interrupt': z.object({ stillQueued: z.array(z.string()) }),
  'session.setModel': z.object({}),
  'session.setPermissionMode': z.object({}),
  'session.setEffort': z.object({}),
  'session.setFastMode': z.object({}),
  'session.rename': z.object({}),
  'session.close': z.object({}),
  'session.resume': z.object({}),
  'session.setPinned': z.object({}),
  'session.setArchived': z.object({}),
  'decision.respond': z.object({ outcome: decisionOutcomeSchema }),
  'transcript.loadEarlier': z.object({ items: z.array(transcriptItemSchema), hasEarlier: z.boolean() }),
  'session.getContext': z.object({ context: contextBreakdownSchema }),
  'session.refreshModels': z.object({ models: z.array(modelOptionSchema) }),
  'settings.update': z.object({ settings: settingsSchema }),
  /** R0-19: the ack comes first, so this is the number of sessions TO stop (counted before closing). */
  'server.shutdown': z.object({ sessionsStopped: z.number().int().nonnegative() }),
} as const satisfies Record<CommandName, z.ZodType>;
export type CommandResult<N extends CommandName> = z.infer<(typeof commandResultSchemas)[N]>;

export const ackSchema = z.discriminatedUnion('ok', [
  z.object({ type: z.literal('ack'), cmdId: cmdIdSchema, ok: z.literal(true), result: z.unknown() }),
  z.object({ type: z.literal('ack'), cmdId: cmdIdSchema, ok: z.literal(false), error: errorPayloadSchema }),
]);
export type AckMessage = z.infer<typeof ackSchema>;

// =====================================================================================
// 7.6 Errors without a command
// =====================================================================================

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  error: errorPayloadSchema,
  /** Raw `type` of the offending client message, if parseable. */
  inReplyTo: z.string().nullable(),
});

// =====================================================================================
// 7.7 Notifications (A.9; the server picks exactly one channel)
// =====================================================================================

export const notifySchema = z.object({
  type: z.literal('notify'),
  notification: z.object({
    id: z.string().min(1),
    kind: notificationKindSchema,
    entryId: entryIdSchema,
    /** Session title; the UI builds the text via t(). */
    title: z.string(),
    /** in_app = hint in the window, system = Web Notification (tag = sessionKey on the client). */
    delivery: z.enum(['in_app', 'system']),
    at: isoDateTimeSchema,
  }),
});
export type Notification = z.infer<typeof notifySchema>['notification'];

/** E.g. the decision was answered elsewhere. */
export const notifyClearSchema = z.object({ type: z.literal('notify.clear'), entryId: entryIdSchema });

// =====================================================================================
// 7.8 Unions and parse helpers
// =====================================================================================

export const clientMessageSchema = z.discriminatedUnion('type', [
  clientHelloSchema,
  presenceMessageSchema,
  subscribeSchema,
  unsubscribeSchema,
  cmdMessageSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];

export const serverMessageSchema = z.discriminatedUnion('type', [
  helloSchema,
  hostStateMessageSchema,
  summariesSnapshotSchema,
  summaryUpsertSchema,
  summaryRemoveSchema,
  sessionSnapshotSchema,
  sessionOpsSchema,
  sessionUnavailableSchema,
  ackSchema,
  errorMessageSchema,
  notifySchema,
  notifyClearSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ServerMessageType = ServerMessage['type'];

/** All server message types (completeness is type-tested in contracts.types.test.ts). */
export const SERVER_MESSAGE_TYPES = [
  'hello',
  'host.state',
  'summaries.snapshot',
  'summary.upsert',
  'summary.remove',
  'session.snapshot',
  'session.ops',
  'session.unavailable',
  'ack',
  'error',
  'notify',
  'notify.clear',
] as const satisfies readonly ServerMessageType[];

const KNOWN_SERVER_TYPES: ReadonlySet<string> = new Set(SERVER_MESSAGE_TYPES);

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function issuePath(error: z.ZodError): string {
  const first = error.issues[0];
  return first === undefined ? '' : first.path.map(String).join('.');
}

function issueMessage(error: z.ZodError): string {
  return (error.issues[0]?.message ?? 'invalid').slice(0, 2000);
}

/** Own property of a plain JSON object, without type assertions. */
function recordField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, key)) {
    return undefined;
  }
  const field: unknown = Reflect.get(value, key);
  return field;
}

export type ParseClientMessageResult =
  { ok: true; message: ClientMessage } | { ok: false; error: ErrorPayload; cmdId: string | null };

/**
 * Server side: JSON text → ClientMessage. Invalid message without a valid cmdId → INVALID_MESSAGE
 * (server answers with an `error` message); `cmd` with a valid cmdId → VALIDATION_FAILED +
 * `params.path` (server answers with `ack{ok:false}`, §7.6).
 */
export function parseClientMessage(text: string): ParseClientMessageResult {
  const json = parseJson(text);
  if (!json.ok) {
    return {
      ok: false,
      error: makeError('INVALID_MESSAGE', { reason: 'json' }, 'invalid JSON'),
      cmdId: null,
    };
  }
  const parsed = clientMessageSchema.safeParse(json.value);
  if (parsed.success) return { ok: true, message: parsed.data };

  const path = issuePath(parsed.error);
  const message = issueMessage(parsed.error);
  const cmdId =
    recordField(json.value, 'type') === 'cmd'
      ? cmdIdSchema.safeParse(recordField(json.value, 'cmdId'))
      : null;
  if (cmdId?.success === true) {
    return { ok: false, error: makeError('VALIDATION_FAILED', { path }, message), cmdId: cmdId.data };
  }
  return { ok: false, error: makeError('INVALID_MESSAGE', { reason: 'schema', path }, message), cmdId: null };
}

export type ParseServerMessageResult =
  { ok: true; message: ServerMessage } | { ok: 'ignored'; type: string } | { ok: false; error: ErrorPayload };

/**
 * Client side: unknown `type` → `{ ok: 'ignored', type }` (count it, forward-compatible, §2.3);
 * invalid known message → `{ ok: false }`.
 */
export function parseServerMessage(text: string): ParseServerMessageResult {
  const json = parseJson(text);
  if (!json.ok) return { ok: false, error: makeError('INVALID_MESSAGE', { reason: 'json' }, 'invalid JSON') };
  const type = recordField(json.value, 'type');
  if (typeof type === 'string' && !KNOWN_SERVER_TYPES.has(type)) return { ok: 'ignored', type };
  const parsed = serverMessageSchema.safeParse(json.value);
  if (parsed.success) return { ok: true, message: parsed.data };
  return {
    ok: false,
    error: makeError(
      'INVALID_MESSAGE',
      { reason: 'schema', path: issuePath(parsed.error) },
      issueMessage(parsed.error),
    ),
  };
}

/** Mapped view of commandResultSchemas: indexing it with a generic N keeps the result type. */
type CommandResultSchemaMap = { [N in CommandName]: z.ZodType<CommandResult<N>> };
const resultSchemaMap: CommandResultSchemaMap = commandResultSchemas;

/** Typed ack result on the client; null if the result does not match the command's schema. */
export function parseCommandResult<N extends CommandName>(name: N, result: unknown): CommandResult<N> | null {
  const schema = resultSchemaMap[name];
  const parsed = schema.safeParse(result);
  return parsed.success ? parsed.data : null;
}
