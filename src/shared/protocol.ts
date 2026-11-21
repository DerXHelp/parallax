/**
 * WebSocket protocol between web UI and server (A.2, A.9, B, C.11). One JSON object per frame,
 * discriminator `type`. On the wire there is only `entryId`, never `hostId`/`sessionKey` (B
 * "Vereinfachungen"). Design (normative): docs/wp/WP-02.md §7; versioning rules §13.
 */
import { z } from 'zod';
import {
  LIMITS,
  blobIdSchema,
  claudeSessionIdSchema,
  clientIdSchema,
  cmdIdSchema,
  conversationIdSchema,
  decisionIdSchema,
  effortLevelSchema,
  entryIdSchema,
  hostIdSchema,
  isoDateTimeSchema,
  itemIdSchema,
  messageUuidSchema,
  modelNameSchema,
  permissionModeSchema,
  profileIdSchema,
  promptPrioritySchema,
  reviewCommentIdSchema,
  terminalIdSchema,
} from './common';
import { errorPayloadSchema, makeError, type ErrorPayload } from './errors';
import {
  appVersionSchema,
  claudeInstallStatusSchema,
  contextBreakdownSchema,
  decisionOutcomeSchema,
  decisionResponseSchema,
  decisionSchema,
  draftInputSchema,
  fileInfoSchema,
  fileOpenTargetSchema,
  fileStatResultSchema,
  fsListingSchema,
  gitDiffFileSchema,
  gitDiffScopeSchema,
  gitRefNameSchema,
  gitShaSchema,
  gitStatusSchema,
  gitWorktreeSchema,
  hostAddressSchema,
  hostColorSchema,
  hostNameSchema,
  hostStateSchema,
  httpUrlSchema,
  mcpActionSchema,
  modelOptionSchema,
  multiHostConfigSchema,
  multiHostRoleSchema,
  planAnnotationsSchema,
  planVersionInfoSchema,
  profileInputSchema,
  profileIssueSchema,
  profileSchema,
  reloadTargetSchema,
  remoteAccessCheckSchema,
  remoteEventSchema,
  remoteHostIdSchema,
  remotePeerLevelSchema,
  remotePortSchema,
  reviewAnchorFields,
  reviewCommentSchema,
  reviewCommentsSchema,
  isReviewRange,
  searchHitSchema,
  REMOTE_PEER_LEVELS,
  type RemotePeerLevel,
  REMOTE_ACCESS_DEFAULT_PORT,
  sessionDetailPatchSchema,
  sessionDetailSchema,
  sessionFileSchema,
  sessionInfoSectionNameSchema,
  sessionInfoSectionSchema,
  sessionSummarySchema,
  settingsPatchSchema,
  subagentIdSchema,
  subagentTranscriptPageSchema,
  SUBAGENT_TRANSCRIPT_LIMITS,
  settingsSchema,
  shellKindSchema,
  WINDOWS_SHELL_KINDS,
  transcriptItemSchema,
  worktreeInspectionSchema,
} from './model';
import { NAME_MAX_CHARS } from './paths';
import { notificationKindSchema } from './status';

/**
 * Bump rules: docs/wp/WP-02.md §13 (not for new optional fields, server message types or commands).
 * 2 (Phase 2, ADR-100): new error codes, the system event `handoff` and new commands are members of
 * closed unions a v1 client cannot parse; with several hosts build ids differ legitimately.
 * 3 (Phase 3, ADR-140): new error codes and commands (file service, plan versions, stopTask).
 * 4 (WP-87, ADR-220): update.* commands, UPDATE_* error codes, close code SERVER_RESTARTING.
 * 5 (WP-76, docs/wp/WP-76.md §C): several computers – hosts.*, remoteAccess.*, multiHost.configure,
 *   session.setDraft, HOST_* / PAIRING_* / REMOTE_* / DRAFT_TOO_LARGE, `clientHello.kind`, close codes
 *   of the forwarder.
 * 6 (WP-95, ADR-236): the system events `attachments_missing` and `peer_message_hold`.
 * 7 (WP-102, Linux): shell kinds login/bash/zsh/fish/pwsh, `shell.detect` → `shells`, `HostState.capabilities`.
 * 8 (WP-110, Ausbau 1): git.*, worktree.*, review.*, search.query, transcript.loadAround,
 *   session.setUnread, the ops review.upsert/review.remove, the decision kind `elicitation`, the cancel
 *   reason `user`, GIT_* / WORKTREE_* / BRANCH_EXISTS / SEARCH_FAILED / ELICITATION_UNSUPPORTED,
 *   `HostState.features`.
 */
export const PROTOCOL_VERSION = 8;
/** WP-70: longest pasted sign-in code (`profile.loginCode`; a link with code and state fits). */
export const LOGIN_CODE_CHARS = 4000;
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
  /** WP-87: ordered restart for an update or a rollback – unlike 4503 the window reconnects. */
  SERVER_RESTARTING: 4504,
  // ---- WP-76: forwarder of a controlling computer (`/api/hosts/:hostId/ws`) ----
  /** The other computer is not reachable (or the connection to it broke) – the window retries with backoff. */
  HOST_UNREACHABLE: 4502,
  /** The other computer runs another Parallax or protocol version – no retry until HostState changes. */
  HOST_INCOMPATIBLE: 4410,
  /** The coupling was revoked (by either side) or the computer was removed – no retry. */
  HOST_REVOKED: 4403,
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
  /**
   * WP22-03 (additive, optional): this window can show Web Notifications (permission granted).
   * `false` → the server delivers a `system` notification as a native Windows toast instead (when
   * `HostState.nativeNotifications`). Absent (older client) = assumed true.
   */
  systemNotifications: z.boolean().optional(),
});
export type PresenceState = z.infer<typeof presenceStateSchema>;

/** Sent after every change (debounced 250 ms). */
export const presenceMessageSchema = z.object({ type: z.literal('presence'), presence: presenceStateSchema });

// =====================================================================================
// 7.1 Handshake
// =====================================================================================

/**
 * What a connection may do (WP-102, WP-76 §B.13): `local` = a window of this computer (everything);
 * `control`/`manage` = a window of a controlling computer with that coupling level.
 */
export const CONNECTION_ACCESS = ['local', ...REMOTE_PEER_LEVELS] as const;
export const connectionAccessSchema = z.enum(CONNECTION_ACCESS);
export type ConnectionAccess = z.infer<typeof connectionAccessSchema>;

export const helloSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int().positive(),
  /** 'dev' in dev mode, otherwise the build id (`BUILD_ID`, src/shared/build.ts). */
  buildId: z.string().min(1).max(LIMITS.buildIdChars),
  /** New on every server start → client full resync. */
  serverInstanceId: z.uuid(),
  serverVersion: z.string(),
  serverStartedAt: isoDateTimeSchema,
  /**
   * WP-102: what this connection may do – display only (settings, profiles and updates of another
   * computer only with `manage`); the hub of that computer checks every command itself.
   */
  access: connectionAccessSchema.default('local'),
});
export type HelloMessage = z.infer<typeof helloSchema>;

/**
 * WP-76: `window` = a browser window (directly or through the forwarder of a controlling computer);
 * `relay` = the watcher connection of a controlling computer's server (only over remote access, at
 * most one; no subscriptions, no commands; receives the notifications for that computer, ADR-207).
 */
export const CLIENT_KINDS = ['window', 'relay'] as const;
export const clientKindSchema = z.enum(CLIENT_KINDS);
export type ClientKind = z.infer<typeof clientKindSchema>;

export const clientHelloSchema = z.object({
  type: z.literal('clientHello'),
  protocolVersion: z.number().int().positive(),
  buildId: z.string().min(1).max(LIMITS.buildIdChars),
  /** Stable per window (sessionStorage). */
  clientId: clientIdSchema,
  presence: presenceStateSchema,
  kind: clientKindSchema.default('window'),
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
    /**
     * Phase 2 (ADR-107): the new current conversation already has older items (switch to an earlier
     * conversation) – the engine follows with item.upserts of its tail. Producers always set it (R0-28).
     */
    hasEarlier: z.boolean().default(false),
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
  /**
   * WP-110 (ADR-254): new or changed review comments – replaced by id, new ones appended
   * (`SessionDetail.review` keeps the order of creation).
   */
  z.object({ op: z.literal('review.upsert'), comments: reviewCommentsSchema.min(1) }),
  /** WP-110: review comments deleted (unknown ids are ignored). */
  z.object({
    op: z.literal('review.remove'),
    commentIds: z.array(reviewCommentIdSchema).min(1).max(LIMITS.reviewCommentsMax),
  }),
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
    /** Images, PDFs and other files uploaded via `POST /api/attachments` before (ADR-103, ADR-146). */
    attachments: z
      .array(z.object({ blobId: blobIdSchema }))
      .max(LIMITS.attachmentsMax)
      .default([]),
    /** Phase 3 (ADR-146): pasted texts that occur verbatim in `text` (→ SDK inline_pastes). */
    pastes: z.array(z.string().min(1).max(LIMITS.promptChars)).max(LIMITS.pastesMax).default([]),
  })
  .refine((p) => p.text.trim() !== '' || p.attachments.length > 0, { message: 'empty prompt' });
export type PromptInput = z.infer<typeof promptInputSchema>;

/** WP-110: `session.create.worktree`. */
export const sessionWorktreeRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('new'), branch: gitRefNameSchema, baseRef: gitRefNameSchema.optional() }),
  z.object({ mode: z.literal('existing'), path: z.string().min(1).max(LIMITS.pathChars) }),
]);
export type SessionWorktreeRequest = z.infer<typeof sessionWorktreeRequestSchema>;

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
    /**
     * WP-110 (ADR-250): run the session in a worktree of the repository of `cwd` – `new`: create
     * `<repo>/.claude/worktrees/<branch>` on a new branch from `baseRef` (missing = the current branch
     * of the main worktree); `existing`: a worktree of `worktree.list`. NOT_A_GIT_REPO, WORKTREE_EXISTS,
     * BRANCH_EXISTS, GIT_FAILED {op: 'worktree_add'}. Requires `HostState.features.git`.
     */
    worktree: sessionWorktreeRequestSchema.optional(),
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
  // ---- Phase 2 (WP-30 §4.6; rules: architecture §5.2) ----
  /** Make an earlier conversation of the entry current again (ADR-107). */
  z.object({
    name: z.literal('session.switchConversation'),
    entryId: entryIdSchema,
    conversationId: conversationIdSchema,
  }),
  /** Close the SDK query and run `claude --resume <id>` in a visible console (ADR-104). */
  z.object({ name: z.literal('session.openExternal'), entryId: entryIdSchema }),
  /**
   * 102e "Continue in terminal": like `session.openExternal`, but `claude --resume <id>` runs in a new
   * embedded terminal of the entry (`TerminalInfo.command: 'claude'`) instead of a window – also for a
   * server without a desktop and for a controlling computer (through the terminal relay, ADR-244).
   */
  z.object({ name: z.literal('session.openInTerminal'), entryId: entryIdSchema }),
  /** Take the session back from the external console (only after the console ended). */
  z.object({ name: z.literal('session.reclaim'), entryId: entryIdSchema }),
  /** PowerShell line for "copy console command"; changes nothing. */
  z.object({ name: z.literal('session.consoleCommand'), entryId: entryIdSchema }),
  /** enabled: send "continue" at rateLimitedUntil (now if past); false: cancel (ADR-112). */
  z.object({ name: z.literal('session.continueAfterLimit'), entryId: entryIdSchema, enabled: z.boolean() }),
  z.object({ name: z.literal('profile.get'), profileId: profileIdSchema }),
  z.object({ name: z.literal('profile.save'), profile: profileInputSchema }),
  z.object({ name: z.literal('profile.delete'), profileId: profileIdSchema }),
  z.object({ name: z.literal('profile.setDefault'), profileId: profileIdSchema }),
  z.object({ name: z.literal('profile.test'), profileId: profileIdSchema }),
  /** Findings of an unsaved input (live validation in the editor); writes nothing. */
  z.object({ name: z.literal('profile.validate'), profile: profileInputSchema }),
  /** Folder browser (ADR-119); `path: null` = the roots (drives + user folder). */
  z.object({
    name: z.literal('fs.listDirectory'),
    path: z.string().min(1).max(LIMITS.pathChars).nullable(),
    showHidden: z.boolean().default(false),
  }),
  // ---- Phase 3 (WP-50 §4.6; rules: architecture §5.2) ----
  /** Stop one background task (agent.stopTask, ADR-149). */
  z.object({
    name: z.literal('session.stopTask'),
    entryId: entryIdSchema,
    taskId: z.string().min(1).max(200),
  }),
  /** Stored plan versions of the entry, ascending (ADR-148). */
  z.object({ name: z.literal('plan.list'), entryId: entryIdSchema }),
  z.object({ name: z.literal('plan.read'), entryId: entryIdSchema, version: z.number().int().positive() }),
  /**
   * WP-93 (ADR-234): replaces the annotations of an OPEN plan decision (the whole list – the last
   * writer wins); every window gets them as `decision.upsert`. DECISION_NOT_FOUND,
   * DECISION_ALREADY_RESOLVED, DECISION_EXPIRED (expired card), DECISION_OPTION_UNAVAILABLE
   * {path: 'annotations'} for another kind of decision, VALIDATION_FAILED
   * {reason: 'duplicate_annotation_id'}.
   */
  z.object({
    name: z.literal('decision.annotatePlan'),
    entryId: entryIdSchema,
    decisionId: decisionIdSchema,
    annotations: planAnnotationsSchema,
  }),
  /** File service (ADR-140/141): routed like host commands, the handler checks the entry itself. */
  z.object({
    name: z.literal('file.stat'),
    entryId: entryIdSchema,
    path: z.string().min(1).max(LIMITS.pathChars),
  }),
  z.object({
    name: z.literal('file.statMany'),
    entryId: entryIdSchema,
    paths: z.array(z.string().min(1).max(LIMITS.pathChars)).min(1).max(LIMITS.fileStatBatchMax),
  }),
  /** Open in the editor, show in Explorer, or open with the default program (ADR-144). */
  z.object({
    name: z.literal('file.open'),
    entryId: entryIdSchema,
    path: z.string().min(1).max(LIMITS.pathChars),
    target: fileOpenTargetSchema,
    line: z.number().int().positive().nullable().default(null),
    col: z.number().int().positive().nullable().default(null),
  }),
  /** "Dateien dieser Session" (ADR-145). */
  z.object({ name: z.literal('files.session'), entryId: entryIdSchema }),
  /** File list of the project for the @ picker (ADR-151). */
  z.object({ name: z.literal('files.project'), entryId: entryIdSchema }),
  /** Installed editor presets and the custom executable (settings "Dateien"). */
  z.object({ name: z.literal('editor.detect') }),
  // ---- WP-63 (user feedback 1) ----
  /**
   * Remove the entry from Parallax only (list, memory, open views → `summary.remove`): a running
   * process is closed first like `session.close`; nothing on disk is deleted (claude transcript,
   * Parallax log, attachments, plan versions stay; `claude --resume` keeps working).
   */
  z.object({ name: z.literal('session.remove'), entryId: entryIdSchema }),
  // ---- WP-64 (Remote Control) ----
  /**
   * The wish for Remote Control (`Entry.remoteControlWanted`): a running process is switched at
   * once (failure: REMOTE_CONTROL_*, the wish stays), a dormant one at its next start. Not for
   * archived (SESSION_ARCHIVED) or external entries (SESSION_EXTERNAL).
   */
  z.object({ name: z.literal('session.setRemoteControl'), entryId: entryIdSchema, enabled: z.boolean() }),
  // ---- WP-65 (overview) ----
  /**
   * Send foreground work to the background (`backgroundTasks`, like Ctrl+B in the terminal): with
   * `toolUseId` the running Bash call or subagent of that tool_use (TASK_NOT_FOUND when nothing
   * matches), with null everything in the foreground. Needs a running process (SESSION_NOT_RUNNING);
   * not for archived (SESSION_ARCHIVED) or external entries (SESSION_EXTERNAL).
   */
  z.object({
    name: z.literal('session.backgroundTasks'),
    entryId: entryIdSchema,
    toolUseId: z.string().min(1).max(200).nullable(),
  }),
  /**
   * A new AI title from the first prompt, the last prompt and the start of the last answer – the
   * result is `titleSource 'ai'` even over a custom title (the user asked for it). A dormant entry is
   * started for it; CLAUDE_CONTROL_FAILED when the CLI cannot make titles. Not for archived or
   * external entries.
   */
  z.object({ name: z.literal('session.regenerateTitle'), entryId: entryIdSchema }),
  // ---- WP-66 (side question, withdraw a queued prompt) ----
  /**
   * A side question (`/btw`): answered from the current conversation state without tools and never
   * part of the conversation. The engine creates a `side_question` item (status `pending`) in the
   * current conversation at once and answers with its id; the answer arrives as an item update. A
   * dormant entry is started for it (no turn). `threadId`: a follow-up of that thread (its answered
   * questions go along as history), null = a new thread. Not for archived or external entries.
   */
  z.object({
    name: z.literal('session.askSideQuestion'),
    entryId: entryIdSchema,
    question: z.string().trim().min(1).max(LIMITS.sideQuestionChars),
    threadId: itemIdSchema.nullable(),
  }),
  /** Cancel a pending side question (→ status `cancelled`); anything else is a no-op. */
  z.object({ name: z.literal('session.cancelSideQuestion'), entryId: entryIdSchema, itemId: itemIdSchema }),
  /** Remove a whole side-question thread from Parallax (`item.remove` of each of its items). */
  z.object({ name: z.literal('session.deleteSideQuestion'), entryId: entryIdSchema, threadId: itemIdSchema }),
  /**
   * Take a queued prompt back (`cancelAsyncMessage`): `withdrawn` → it left the queue and `text` is
   * the typed text (for the composer); false = already taken over by the CLI (nothing changes).
   * Needs a running process (SESSION_NOT_RUNNING); CLAUDE_CONTROL_FAILED when the CLI cannot do it.
   */
  z.object({
    name: z.literal('session.withdrawQueued'),
    entryId: entryIdSchema,
    messageUuid: messageUuidSchema,
  }),
  // ---- WP-67 (session info with tabs) ----
  /**
   * The data of one "Session info" tab from the running CLI (`/status`, `/memory`, `/skills`,
   * `/hooks`, `/permissions`, MCP servers, `/export`) – read-only, only on request (never polled or
   * cached). `available: false` (data null) = this `claude` cannot answer it (method missing,
   * unknown answer shape). Needs a running process (SESSION_NOT_RUNNING – no wake-up just to show
   * data); a failed request → CLAUDE_CONTROL_FAILED. Not for archived or external entries.
   */
  z.object({
    name: z.literal('session.info'),
    entryId: entryIdSchema,
    section: sessionInfoSectionNameSchema,
  }),
  /**
   * Reconnect an MCP server or switch it on/off (`reconnectMcpServer`, `toggleMcpServer`); the tab
   * then asks again. Needs a running process (SESSION_NOT_RUNNING); failure → CLAUDE_CONTROL_FAILED.
   */
  z.object({
    name: z.literal('session.mcpAction'),
    entryId: entryIdSchema,
    server: z.string().min(1).max(500),
    action: mcpActionSchema,
  }),
  /** Reload skills or plugins from disk (`reloadSkills`, `reloadPlugins`); rules as `session.mcpAction`. */
  z.object({ name: z.literal('session.reload'), entryId: entryIdSchema, what: reloadTargetSchema }),
  // ---- WP-69 (subagent transcript) ----
  /**
   * Read a subagent's own transcript (`getSubagentMessages`, the CLI's `agent-<id>.jsonl`) as items of
   * a list of its own – never part of the session's conversation, nothing is stored. Only on request
   * (the side panel polls while `running`). `conversationId` null = the current conversation;
   * `offset` null = the newest `limit` items. Works without a process (reads the file) and for
   * archived/external entries. A missing file is an empty page; CONVERSATION_NOT_FOUND,
   * SESSION_NOT_STARTED (no Claude session yet), FILE_NOT_READABLE (the read failed or timed out).
   */
  z.object({
    name: z.literal('session.subagentTranscript'),
    entryId: entryIdSchema,
    agentId: subagentIdSchema,
    conversationId: conversationIdSchema.nullable().default(null),
    offset: z.number().int().nonnegative().nullable().default(null),
    limit: z
      .number()
      .int()
      .positive()
      .max(SUBAGENT_TRANSCRIPT_LIMITS.maxPageItems)
      .default(SUBAGENT_TRANSCRIPT_LIMITS.pageItems),
  }),
  /**
   * Host: open an http(s) link in the Windows default browser (the Parallax window is a Chrome app
   * profile without any sign-in). OPEN_FAILED when no default browser could be started – the client
   * then falls back to `window.open`.
   */
  z.object({ name: z.literal('link.open'), url: httpUrlSchema }),
  // ---- WP-70 (login per profile, output style per project) ----
  /**
   * Host: sign the profile in from Parallax – the CLI's OAuth flow in a short-lived `claude` of the
   * profile (its config folder: all sessions of the profile); the server opens the link in the
   * default browser. Progress and result: `ProfileSummary.login` (host state). A login of the
   * profile that is still starting/waiting is kept (no second process). PROFILE_NOT_FOUND.
   */
  z.object({ name: z.literal('profile.login'), profileId: profileIdSchema }),
  /**
   * Host: the code the sign-in page showed (manual way): `code#state`, a link with `code`/`state` or
   * the bare code (tolerant). The check runs in the background (`login.state` `verifying` → `done` or
   * `failed`). LOGIN_FAILED {reason:'expired'} when the profile has no waiting login.
   */
  z.object({
    name: z.literal('profile.loginCode'),
    profileId: profileIdSchema,
    code: z.string().trim().min(1).max(LOGIN_CODE_CHARS),
  }),
  /** Host: end the profile's login (process closed, state back to idle); none running → no-op. */
  z.object({ name: z.literal('profile.loginCancel'), profileId: profileIdSchema }),
  /**
   * The output style of the entry's project: `updateSettings('localSettings', {outputStyle})` in the
   * session's process (`<cwd>\.claude\settings.local.json`, all sessions in this project; from the
   * next turn on). A dormant entry is started without a turn. VALIDATION_FAILED for a style the CLI
   * does not offer (when the list is known); CLAUDE_CONTROL_FAILED {method:'updateSettings'}. Not
   * for archived or external entries.
   */
  z.object({
    name: z.literal('session.setOutputStyle'),
    entryId: entryIdSchema,
    style: z.string().trim().min(1).max(100),
  }),
  // ---- WP-87 (updates in the app, docs/wp/WP-87.md §1.3) ----
  /** Host: look for a newer release now (also with `updates.check` off). UPDATE_NOT_PACKAGED, UPDATE_BUSY. */
  z.object({ name: z.literal('update.check') }),
  /**
   * Host: download, check and stage `version` (must be `HostState.update.available`, else
   * VALIDATION_FAILED {reason:'version'}); the ack comes at once, progress and outcome in HostState.
   */
  z.object({ name: z.literal('update.prepare'), version: appVersionSchema }),
  /**
   * Host: switch to the prepared `version` (status `ready`): the old version's orchestrator takes
   * over; ack after its handshake, then close 4504 and exit. `acceptDataLoss` is required when the
   * target `needsRestore` (VALIDATION_FAILED {reason:'data_loss_not_accepted'}).
   */
  z.object({
    name: z.literal('update.apply'),
    version: appVersionSchema,
    acceptDataLoss: z.boolean().default(false),
  }),
  /** Host: back to `HostState.update.previous` (same flow as update.apply). */
  z.object({
    name: z.literal('update.rollback'),
    version: appVersionSchema,
    acceptDataLoss: z.boolean().default(false),
  }),
  /** Host: hide a hint – `available` remembers the version (update-state.json), the others clear their field. */
  z.object({
    name: z.literal('update.dismiss'),
    what: z.enum(['available', 'justUpdated', 'failedUpdate', 'error']),
  }),
  // ---- WP-76 (several computers and synchronized drafts, docs/wp/WP-76.md §C) ----
  /**
   * The composer draft of the entry (WP-77, ADR-210); null clears it. Last writer wins in the order
   * the server accepts the commands; the result is the new `rev` (null after clearing). Allowed for
   * every entry state (also archived, external, sleeping). DRAFT_TOO_LARGE above LIMITS.draftTotalChars.
   */
  z.object({
    name: z.literal('session.setDraft'),
    entryId: entryIdSchema,
    draft: draftInputSchema.nullable(),
    /** `rev` the window based its change on (null = none) – for logs and tests; never rejected. */
    baseRev: z.number().int().positive().nullable().default(null),
  }),
  /**
   * Host: role and listener settings of "Several computers" (only the given fields change).
   * REMOTE_ROLE_CONFLICT for share <-> control while the old role still has couplings; the switch to
   * `share` runs the checks first (REMOTE_KEYSTORE_UNAVAILABLE, REMOTE_ACCESS_FAILED).
   */
  z.object({
    name: z.literal('multiHost.configure'),
    role: multiHostRoleSchema.optional(),
    port: z.number().int().min(1024).max(65535).optional(),
    bindAddress: z.ipv4().optional(),
  }),
  /**
   * Host (role share): open a pairing window – a new code replaces an open one; the code only in the ack.
   * WP-102: `level` (absent = `control`) binds the coupling level to this window (WP-76 §B.13); never
   * over remote access.
   */
  z.object({ name: z.literal('remoteAccess.pair'), level: remotePeerLevelSchema.optional() }),
  /** Host (role share): close an open pairing window; none open → no-op. */
  z.object({ name: z.literal('remoteAccess.cancelPairing') }),
  /** Host (role share): revoke the one coupling – its connections close at once. */
  z.object({ name: z.literal('remoteAccess.unpair') }),
  /** Host (role share): new identity key – revokes the coupling (pair again). */
  z.object({ name: z.literal('remoteAccess.renewKey') }),
  /** Host (role share): run the checks again (port, keys, key store, TLS, addresses). */
  z.object({ name: z.literal('remoteAccess.check') }),
  /** Host (role share): the connection log, newest first. */
  z.object({ name: z.literal('remoteAccess.events'), onlyRejected: z.boolean().default(false) }),
  /** Host (role share): mark the rejected attempts as seen (`HostState.remoteAccess.unseenRejected` → 0). */
  z.object({ name: z.literal('remoteAccess.eventsSeen') }),
  /**
   * Host (role share, WP-102): change the level of the one coupling – locally either way, over remote
   * access only with `manage` and only down to `control` (else REMOTE_NOT_ALLOWED). Raises the
   * coupling generation: every connection of it closes (WP-76 §B.13). No coupling → VALIDATION_FAILED
   * {reason:'not_paired'}; the same level → no-op.
   */
  z.object({ name: z.literal('remoteAccess.setPeerLevel'), level: remotePeerLevelSchema }),
  /**
   * Host (role control): pair with a sharing computer and add it. `code` as typed (tolerant, checked
   * locally first: VALIDATION_FAILED {reason:'code'}); PAIRING_INVALID, PAIRING_EXPIRED,
   * PAIRING_RATE_LIMITED, HOST_UNREACHABLE, HOST_INCOMPATIBLE; VALIDATION_FAILED {reason:'limit'} at
   * LIMITS.hostsMax. The ack comes after the pairing finished.
   * `replaceHostId` (WP-80 wish, 18.11.2026): pair an existing entry again (e.g. after `revoked` or a
   * renewed key) – only after a successful pairing the new coupling replaces that entry's key, pin and
   * address; `hostId`, color, place and thus the sessionKeys of its sessions stay (HOST_NOT_FOUND).
   */
  z.object({
    name: z.literal('hosts.add'),
    address: hostAddressSchema,
    port: remotePortSchema.default(REMOTE_ACCESS_DEFAULT_PORT),
    code: z.string().trim().min(1).max(64),
    displayName: hostNameSchema,
    replaceHostId: remoteHostIdSchema.optional(),
  }),
  /** Host (role control): change name, color, address or port (only the given fields). HOST_NOT_FOUND. */
  z.object({
    name: z.literal('hosts.update'),
    hostId: hostIdSchema,
    displayName: hostNameSchema.optional(),
    color: hostColorSchema.optional(),
    address: hostAddressSchema.optional(),
    port: remotePortSchema.optional(),
  }),
  /** Host (role control): move a computer in the list (sidebar order after this computer). */
  z.object({
    name: z.literal('hosts.move'),
    hostId: hostIdSchema,
    index: z.number().int().nonnegative(),
  }),
  /**
   * Host (role control): remove a computer – asks it to drop the coupling when reachable, then deletes
   * key, certificate and pin here. Open windows of it close with HOST_REVOKED. Result `peerNotified`:
   * false = the other computer was not reached, its pairing must be removed there by hand (§B.8).
   */
  z.object({ name: z.literal('hosts.remove'), hostId: hostIdSchema }),
  /** Host (role control): try to connect now (also after `incompatible` or `unreachable`). */
  z.object({ name: z.literal('hosts.reconnect'), hostId: hostIdSchema }),
  /**
   * WP-94 (ADR-235): create the folder `folderName` in `parent` (folder browser, "New folder"). One
   * level, never recursive. PATH_REJECTED {reason} (path or name, `windowsNameIssue`), CWD_NOT_FOUND,
   * CWD_NOT_DIRECTORY, FOLDER_EXISTS {path}, FOLDER_NOT_WRITABLE {path}.
   */
  z.object({
    name: z.literal('fs.createDirectory'),
    parent: z.string().min(1).max(LIMITS.pathChars),
    folderName: z.string().min(1).max(NAME_MAX_CHARS),
  }),
  // ---- WP-97 (ADR-238): shell in the project folder ----
  /**
   * Open cmd, PowerShell or Git Bash as a visible window in the entry's cwd (only on this computer,
   * neutral environment). ENTRY_NOT_FOUND, PATH_REJECTED, CWD_NOT_FOUND, CWD_NOT_DIRECTORY,
   * SHELL_NOT_FOUND {shell}, SHELL_OPEN_FAILED {reason}.
   */
  z.object({ name: z.literal('session.openShell'), entryId: entryIdSchema, shell: shellKindSchema }),
  /** Where Git for Windows is installed (settings "Console"); never cached. */
  z.object({ name: z.literal('shell.detect') }),
  // ---- WP-110 (Ausbau 1): overview, git service, worktrees, review, search ----
  /**
   * F6: mark the entry unread (`true`, stays until the session is opened again – an open window does
   * not clear it at once) or read (`false`). ENTRY_NOT_FOUND.
   */
  z.object({ name: z.literal('session.setUnread'), entryId: entryIdSchema, unread: z.boolean() }),
  /**
   * Git service (ADR-252) in the entry's `cwd`; host-routed (archived and external entries too). Every
   * git command: ENTRY_NOT_FOUND, GIT_NOT_FOUND, NOT_A_GIT_REPO, GIT_FAILED {op}.
   */
  z.object({ name: z.literal('git.status'), entryId: entryIdSchema }),
  /**
   * The changed files of `scope` without patches (load them per file with `git.fileDiff`).
   * `onlySessionFiles`: only files the session touched (`files.session`; the default without a worktree).
   */
  z.object({
    name: z.literal('git.diff'),
    entryId: entryIdSchema,
    scope: gitDiffScopeSchema,
    onlySessionFiles: z.boolean().default(false),
  }),
  /** The patch of one file (`path` relative to the repository root, `/`-separated). */
  z.object({
    name: z.literal('git.fileDiff'),
    entryId: entryIdSchema,
    scope: gitDiffScopeSchema,
    path: z.string().min(1).max(LIMITS.pathChars),
  }),
  /** Commit everything (`paths` missing) or the given files; runs the repository's hooks. */
  z.object({
    name: z.literal('git.commit'),
    entryId: entryIdSchema,
    message: z.string().trim().min(1).max(LIMITS.gitCommitMessageChars),
    paths: z.array(z.string().min(1).max(LIMITS.pathChars)).min(1).max(LIMITS.gitFilesMax).optional(),
  }),
  /** New branch at `HEAD`; `switch` = check it out. BRANCH_EXISTS {branch}. */
  z.object({
    name: z.literal('git.branchCreate'),
    entryId: entryIdSchema,
    /** The new branch (`name` is the command's discriminator). */
    branch: gitRefNameSchema,
    switch: z.boolean(),
  }),
  /** Only without conflicts (GIT_FAILED {op: 'branch_switch'} otherwise). */
  z.object({ name: z.literal('git.branchSwitch'), entryId: entryIdSchema, branch: gitRefNameSchema }),
  /** Without an upstream `-u origin <branch>`. GIT_PUSH_FAILED {reason}. */
  z.object({ name: z.literal('git.push'), entryId: entryIdSchema }),
  /** Worktrees of the repository of `cwd` ("New session" → existing worktree). */
  z.object({ name: z.literal('worktree.list'), cwd: z.string().min(1).max(LIMITS.pathChars) }),
  /** What deleting the entry's worktree would lose (cleanup dialog). VALIDATION_FAILED without worktree. */
  z.object({ name: z.literal('worktree.inspect'), entryId: entryIdSchema }),
  /**
   * Delete the entry's worktree (after the project's teardown, ADR-251) and optionally its branch;
   * `force` = also with uncommitted changes / unmerged branch (WORKTREE_DIRTY otherwise). A failed
   * teardown → GIT_FAILED {op: 'teardown', exitCode}; `skipTeardown` = "Delete anyway". The entry keeps
   * `worktree` = null afterwards. Not while the session runs (SESSION_BUSY).
   */
  z.object({
    name: z.literal('worktree.remove'),
    entryId: entryIdSchema,
    deleteBranch: z.boolean(),
    force: z.boolean(),
    skipTeardown: z.boolean().default(false),
  }),
  /** Review comment on the session diff (ADR-254); the server makes id and time. Op `review.upsert`. */
  z
    .object({
      name: z.literal('review.add'),
      entryId: entryIdSchema,
      ...reviewAnchorFields,
      text: z.string().trim().min(1).max(LIMITS.reviewCommentChars),
    })
    .refine(isReviewRange, { message: 'endLine before line', path: ['endLine'] }),
  /**
   * Change text, anchor (after a re-anchor in the window) or state (`stale`, or back to `open`); only
   * the given fields. VALIDATION_FAILED for an unknown comment.
   */
  z.object({
    name: z.literal('review.update'),
    entryId: entryIdSchema,
    commentId: reviewCommentIdSchema,
    text: z.string().trim().min(1).max(LIMITS.reviewCommentChars).optional(),
    line: reviewAnchorFields.line.optional(),
    endLine: reviewAnchorFields.endLine.optional(),
    quote: reviewAnchorFields.quote.optional(),
    state: z.enum(['open', 'stale']).optional(),
  }),
  /** Delete comments (unknown ids are ignored). Op `review.remove`. */
  z.object({
    name: z.literal('review.remove'),
    entryId: entryIdSchema,
    commentIds: z.array(reviewCommentIdSchema).min(1).max(LIMITS.reviewCommentsMax),
  }),
  /** The window put them into the composer ("Send to Claude") → state `sent`, `sentAt` now. */
  z.object({
    name: z.literal('review.markSent'),
    entryId: entryIdSchema,
    commentIds: z.array(reviewCommentIdSchema).min(1).max(LIMITS.reviewCommentsMax),
  }),
  /**
   * Full-text search over this host's sessions (ADR-255): transcripts, titles, turn summaries, plans;
   * case-insensitive, newest first, at most LIMITS.searchHitsMax. The answer is the ack result (no
   * push); a newer `search.query` of the same window ends the older one with SEARCH_FAILED
   * {reason: 'superseded'}.
   */
  z.object({
    name: z.literal('search.query'),
    text: z.string().trim().min(LIMITS.searchTextMin).max(LIMITS.searchTextMax),
    includeArchived: z.boolean().default(true),
    includeToolOutput: z.boolean().default(false),
  }),
  /**
   * Items around one item of a conversation (jump to a search hit): the item and up to `around` items
   * before and after it, by order (`TranscriptStore.readAround`). VALIDATION_FAILED for an unknown item.
   */
  z.object({
    name: z.literal('transcript.loadAround'),
    entryId: entryIdSchema,
    conversationId: conversationIdSchema,
    itemId: itemIdSchema,
    around: z.number().int().min(0).max(LIMITS.loadAroundMax),
  }),
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandName = Command['name'];
/** The command object of one name, e.g. `CommandOf<'decision.respond'>`. */
export type CommandOf<N extends CommandName> = Extract<Command, { name: N }>;

/**
 * Commands that concern the host, not one session (ADR-101): the engine routes them to the
 * HostCommandHandlers (src/server/sync/ports.ts) of the profile store (WP-32), the folder browser
 * (WP-33) and – Phase 3 (ADR-140) – the file service. The file commands carry an entryId but are
 * routed like host commands: no lifecycle gating (archived/external/sleeping entries can be read);
 * the handler answers ENTRY_NOT_FOUND itself.
 */
export const HOST_COMMAND_NAMES = [
  'profile.get',
  'profile.save',
  'profile.delete',
  'profile.setDefault',
  'profile.test',
  'profile.validate',
  'fs.listDirectory',
  'file.stat',
  'file.statMany',
  'file.open',
  'files.session',
  'files.project',
  'editor.detect',
  'link.open',
  'profile.login',
  'profile.loginCode',
  'profile.loginCancel',
  'update.check',
  'update.prepare',
  'update.apply',
  'update.rollback',
  'update.dismiss',
  'multiHost.configure',
  'remoteAccess.pair',
  'remoteAccess.cancelPairing',
  'remoteAccess.unpair',
  'remoteAccess.renewKey',
  'remoteAccess.check',
  'remoteAccess.events',
  'remoteAccess.eventsSeen',
  'remoteAccess.setPeerLevel',
  'hosts.add',
  'hosts.update',
  'hosts.move',
  'hosts.remove',
  'hosts.reconnect',
  'fs.createDirectory',
  'session.openShell',
  'shell.detect',
  // WP-110: git service, worktrees and review (WP-111), search (WP-112) – no lifecycle gating.
  'git.status',
  'git.diff',
  'git.fileDiff',
  'git.commit',
  'git.branchCreate',
  'git.branchSwitch',
  'git.push',
  'worktree.list',
  'worktree.inspect',
  'worktree.remove',
  'review.add',
  'review.update',
  'review.remove',
  'review.markSent',
  'search.query',
  'transcript.loadAround',
] as const satisfies readonly CommandName[];
export type HostCommandName = (typeof HOST_COMMAND_NAMES)[number];
export type HostCommand = Extract<Command, { name: HostCommandName }>;

const HOST_COMMANDS: ReadonlySet<string> = new Set(HOST_COMMAND_NAMES);

/** Is this a host command (routed to a HostCommandHandler, never through the lifecycle gate)? */
export function isHostCommand(cmd: Command): cmd is HostCommand {
  return HOST_COMMANDS.has(cmd.name);
}

/**
 * WP-76 (ADR-208): what a window of a controlling computer may do over remote access. Fail-closed:
 * the hub of the sharing computer accepts only these names on a remote connection and answers every
 * other command with REMOTE_NOT_ALLOWED {command}. Every command name is in exactly one of the three
 * lists (allowed, `REMOTE_MANAGE_COMMANDS`, denied; protocol.test.ts) – a new command must be classified.
 */
export const REMOTE_ALLOWED_COMMANDS = [
  'session.create',
  'session.sendPrompt',
  'session.interrupt',
  'session.setModel',
  'session.setPermissionMode',
  'session.setEffort',
  'session.setFastMode',
  'session.rename',
  'session.close',
  'session.resume',
  'session.setPinned',
  'session.setArchived',
  'decision.respond',
  'transcript.loadEarlier',
  'session.getContext',
  'session.refreshModels',
  'session.switchConversation',
  'session.reclaim',
  // 102e: the terminal runs on the sharing computer and is reached through the relay (E3, ADR-244).
  'session.openInTerminal',
  'session.continueAfterLimit',
  'fs.listDirectory',
  'session.stopTask',
  'plan.list',
  'plan.read',
  'decision.annotatePlan',
  'file.stat',
  'file.statMany',
  'files.session',
  'files.project',
  'session.remove',
  'session.setRemoteControl',
  'session.backgroundTasks',
  'session.regenerateTitle',
  'session.askSideQuestion',
  'session.cancelSideQuestion',
  'session.deleteSideQuestion',
  'session.withdrawQueued',
  'session.info',
  'session.mcpAction',
  'session.reload',
  'session.subagentTranscript',
  'session.setOutputStyle',
  'session.setDraft',
  // WP-94: a folder for a new session – less than a session started there may do anyway.
  'fs.createDirectory',
  // WP-102 (E3): the shells of this computer, for the embedded terminal of a controlling computer.
  'shell.detect',
  // WP-110: reading (status, diffs, worktrees, search) and changing (commit, branch, push, worktree
  // removal, review, unread) – both need at least `control`, like controlling the session itself.
  'session.setUnread',
  'git.status',
  'git.diff',
  'git.fileDiff',
  'git.commit',
  'git.branchCreate',
  'git.branchSwitch',
  'git.push',
  'worktree.list',
  'worktree.inspect',
  'worktree.remove',
  'review.add',
  'review.update',
  'review.remove',
  'review.markSent',
  'search.query',
  'transcript.loadAround',
] as const satisfies readonly CommandName[];

/**
 * WP-102 (E2, WP-76 §B.13): only with the coupling level `manage` – settings, profiles (env values,
 * sign-in), server, updates, role and the coupling itself (not a new pairing window: its code goes
 * only to a local window or the local command line).
 */
export const REMOTE_MANAGE_COMMANDS = [
  'settings.update',
  'server.shutdown',
  'profile.get',
  'profile.save',
  'profile.delete',
  'profile.setDefault',
  'profile.test',
  'profile.validate',
  'profile.login',
  'profile.loginCode',
  'profile.loginCancel',
  'update.check',
  'update.prepare',
  'update.apply',
  'update.rollback',
  'update.dismiss',
  'multiHost.configure',
  'remoteAccess.unpair',
  'remoteAccess.renewKey',
  'remoteAccess.check',
  'remoteAccess.events',
  'remoteAccess.eventsSeen',
  'remoteAccess.setPeerLevel',
] as const satisfies readonly CommandName[];

/**
 * Never over remote access, whatever the level: a pairing window (its code), visible programs on this
 * computer's desktop (editor, Explorer, console, browser, shell window), the console command (contains
 * the profile's environment) and this computer's own list of other computers.
 */
export const REMOTE_DENIED_COMMANDS = [
  'session.openExternal',
  'session.consoleCommand',
  'file.open',
  'editor.detect',
  'link.open',
  'remoteAccess.pair',
  'remoteAccess.cancelPairing',
  'hosts.add',
  'hosts.update',
  'hosts.move',
  'hosts.remove',
  'hosts.reconnect',
  // WP-97: a visible shell on this computer's desktop.
  'session.openShell',
] as const satisfies readonly CommandName[];

const REMOTE_ALLOWED: ReadonlySet<string> = new Set(REMOTE_ALLOWED_COMMANDS);
const REMOTE_MANAGE: ReadonlySet<string> = new Set(REMOTE_MANAGE_COMMANDS);

/**
 * May a window of a controlling computer with this coupling level send this command (fail-closed;
 * WP-102: `level` defaults to `control`, anything unknown counts as `control`)?
 */
export function isRemoteAllowedCommand(name: CommandName, level: RemotePeerLevel = 'control'): boolean {
  if (REMOTE_ALLOWED.has(name)) return true;
  return level === 'manage' && REMOTE_MANAGE.has(name);
}

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
  'session.switchConversation': z.object({}),
  'session.openExternal': z.object({ pid: z.number().int().positive().nullable() }),
  /** 102e: the new terminal (the panel attaches to it). */
  'session.openInTerminal': z.object({ terminalId: terminalIdSchema }),
  'session.reclaim': z.object({ importedItems: z.number().int().nonnegative() }),
  /** PowerShell line (cwd, explicit profile env, exe, args) and the Claude session id. */
  'session.consoleCommand': z.object({ command: z.string(), sessionId: claudeSessionIdSchema }),
  'session.continueAfterLimit': z.object({ continueAt: isoDateTimeSchema.nullable() }),
  /** The full profile INCLUDING env values – only in the ack to the asking window. */
  'profile.get': z.object({
    profile: profileSchema,
    issues: z.array(profileIssueSchema),
    entryCount: z.number().int().nonnegative(),
  }),
  'profile.save': z.object({ profileId: profileIdSchema }),
  'profile.delete': z.object({}),
  'profile.setDefault': z.object({}),
  'profile.test': z.object({ claude: claudeInstallStatusSchema }),
  'profile.validate': z.object({ issues: z.array(profileIssueSchema) }),
  'fs.listDirectory': fsListingSchema,
  'session.stopTask': z.object({}),
  'plan.list': z.object({ versions: z.array(planVersionInfoSchema) }),
  /** WP-93: `annotations` = those kept in the version's record (sent with "Keep planning" or still open). */
  'plan.read': z.object({
    version: z.number().int().positive(),
    text: z.string(),
    annotations: planAnnotationsSchema.default([]),
  }),
  'decision.annotatePlan': z.object({}),
  'file.stat': z.object({ file: fileInfoSchema }),
  /** One result per requested path, in request order. */
  'file.statMany': z.object({ results: z.array(fileStatResultSchema) }),
  'file.open': z.object({}),
  /** Newest `lastAt` first. */
  'files.session': z.object({ files: z.array(sessionFileSchema), truncated: z.boolean() }),
  /** `files` relative to `root` (= cwd), separator '/'. */
  'files.project': z.object({
    root: z.string(),
    files: z.array(z.string()),
    truncated: z.boolean(),
    source: z.enum(['git', 'walk']),
  }),
  /** Detected executables of the presets (null = not found) and the check of a custom one. */
  'editor.detect': z.object({
    notepadpp: z.string().nullable(),
    vscode: z.string().nullable(),
    custom: z.object({ executable: z.string(), exists: z.boolean() }).nullable(),
  }),
  'session.remove': z.object({}),
  'session.setRemoteControl': z.object({}),
  'session.backgroundTasks': z.object({}),
  'session.regenerateTitle': z.object({}),
  'session.askSideQuestion': z.object({ itemId: itemIdSchema }),
  'session.cancelSideQuestion': z.object({}),
  'session.deleteSideQuestion': z.object({}),
  'session.withdrawQueued': z.object({ withdrawn: z.boolean(), text: z.string().nullable() }),
  /** `data` is null exactly when `available` is false. */
  'session.info': z.object({ available: z.boolean(), data: sessionInfoSectionSchema.nullable() }),
  'session.mcpAction': z.object({}),
  'session.reload': z.object({}),
  'session.subagentTranscript': subagentTranscriptPageSchema,
  'link.open': z.object({}),
  'profile.login': z.object({}),
  'profile.loginCode': z.object({}),
  'profile.loginCancel': z.object({}),
  'session.setOutputStyle': z.object({}),
  /** The newer version found (null = none, also for a 404 of latest.json). */
  'update.check': z.object({ available: appVersionSchema.nullable() }),
  /** Started – progress and outcome in HostState.update. */
  'update.prepare': z.object({}),
  /** The orchestrator took over; the server closes with 4504 and exits right after this ack. */
  'update.apply': z.object({}),
  'update.rollback': z.object({}),
  'update.dismiss': z.object({}),
  /** The new `rev`; null after clearing. */
  'session.setDraft': z.object({ rev: z.number().int().positive().nullable() }),
  'multiHost.configure': z.object({ config: multiHostConfigSchema }),
  /** Only to the asking window: never in HostState, never logged. */
  'remoteAccess.pair': z.object({
    code: z.string().min(1).max(64),
    expiresAt: isoDateTimeSchema,
    hostName: z.string().max(LIMITS.hostAddressChars),
    addresses: z.array(z.string().max(64)).max(32),
    port: remotePortSchema,
  }),
  'remoteAccess.cancelPairing': z.object({}),
  'remoteAccess.unpair': z.object({}),
  'remoteAccess.renewKey': z.object({}),
  'remoteAccess.check': z.object({ checks: z.array(remoteAccessCheckSchema) }),
  'remoteAccess.events': z.object({ events: z.array(remoteEventSchema) }),
  'remoteAccess.eventsSeen': z.object({}),
  'remoteAccess.setPeerLevel': z.object({}),
  'hosts.add': z.object({ hostId: hostIdSchema }),
  'hosts.update': z.object({}),
  'hosts.move': z.object({}),
  'hosts.remove': z.object({ peerNotified: z.boolean() }),
  'hosts.reconnect': z.object({}),
  /** The created folder: `parent` + separator + `folderName`, in the spelling of `parent`. */
  'fs.createDirectory': z.object({ path: z.string() }),
  /** PID of the started window process (null = unknown). */
  'session.openShell': z.object({ pid: z.number().int().positive().nullable() }),
  /** The Git for Windows folder (holds `git-bash.exe`), null = not found. */
  /** WP-102: `shells` = the kinds installed on this host, in display order (older servers: the Windows three). */
  'shell.detect': z.object({
    gitDir: z.string().nullable(),
    shells: z.array(shellKindSchema).default([...WINDOWS_SHELL_KINDS]),
  }),
  'session.setUnread': z.object({}),
  'git.status': z.object({ status: gitStatusSchema }),
  /** `files` without patches; `base` = the commit the scope starts at (null = `HEAD`/index scopes). */
  'git.diff': z.object({
    root: z.string(),
    base: gitShaSchema.nullable(),
    files: z.array(gitDiffFileSchema),
    truncated: z.boolean(),
  }),
  'git.fileDiff': z.object({ file: gitDiffFileSchema }),
  'git.commit': z.object({ sha: gitShaSchema }),
  'git.branchCreate': z.object({}),
  'git.branchSwitch': z.object({}),
  'git.push': z.object({}),
  /** `repoRoot` null = `cwd` is in no repository (then `worktrees` is empty). */
  'worktree.list': z.object({ repoRoot: z.string().nullable(), worktrees: z.array(gitWorktreeSchema) }),
  'worktree.inspect': worktreeInspectionSchema,
  'worktree.remove': z.object({}),
  'review.add': z.object({ comment: reviewCommentSchema }),
  'review.update': z.object({ comment: reviewCommentSchema }),
  'review.remove': z.object({}),
  'review.markSent': z.object({}),
  /** Newest first; `truncated` = more than LIMITS.searchHitsMax hits. */
  'search.query': z.object({ hits: z.array(searchHitSchema), truncated: z.boolean() }),
  /** By order; `hasEarlier`/`hasLater` = more items before / after the returned ones. */
  'transcript.loadAround': z.object({
    items: z.array(transcriptItemSchema),
    hasEarlier: z.boolean(),
    hasLater: z.boolean(),
  }),
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
