/**
 * Port: normalizer + status machine (WP-12) ↔ session engine (WP-13). Types only; frozen like
 * src/shared. Design: docs/wp/WP-02.md §9.4; rules added by R0 (R0-05, R0-11, R0-28, R0-29):
 * docs/architecture.md §6/§7.
 *
 * WP-12 modules (fixed names): sessions/normalizer/index.ts exports createLiveNormalizer,
 * normalizeHistory, normalizeContextUsage; sessions/normalizer/sdk-schemas.ts (tolerant zod
 * schemas of SDK messages); sessions/status/machine.ts exports reduceStatus. Synthetic test
 * streams (SDK types without a recorded fixture) live as `.ts` modules in
 * sessions/normalizer/synthetic/*.ts (fixture format v1, checked with fixtureEventSchema) –
 * never as `.jsonl` outside test/fixtures/sdk (git-ignored, R0-06).
 *
 * Single writer per SessionDetail field: normalizer → init, backgroundTasks, promptSuggestion,
 * rateLimit, unknownCounts; engine → conversationId, conversations, queue, models. Phase 2
 * (ADR-108): `commands` has two writers that both REPLACE the whole list (the last one wins): the
 * normalizer (`system/commands_changed`) and the engine (`supportedCommands()` at readiness, the
 * per-entry cache for dormant entries).
 *
 * Normalizer rules (normative, tested by WP-12):
 * - Unknown enum values of a newer CLI (permission mode, effort) become null and are counted as
 *   `unknownEnumCountKey(...)` in unknownCounts; unknown effort levels are dropped
 *   (parsePermissionMode / parseEffortLevels in @shared/common).
 * - Size: every item stays within LIMITS.itemTotalChars (assistant text exempt); over budget,
 *   move content into blobs in this order: result.structured → result text parts → input strings.
 *   Bash/PowerShell/Read: fields of `structured` already contained in `content` (stdout, stderr,
 *   file.content) are removed from `structured` (no duplicate text, R0-11).
 * - Every emitted op must survive `sessionOpSchema.parse` unchanged (no `undefined` where the
 *   schema has a null default); the snapshot tests assert this for every op (R0-28).
 */
import type { ConversationId, EntryId, PermissionMode } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type {
  BlobRef,
  ContextBreakdown,
  RateLimitInfo,
  ToolDecisionRef,
  TranscriptItem,
} from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import type { StatusFacts } from '@shared/status';
import type { HistoryMessage } from '../backend/types';

export interface NormalizerContext {
  entryId: EntryId;
  conversationId: ConversationId;
  /** First `order` to assign (conversation.lastOrder + 1). */
  nextOrder: number;
  /** Content-addressed blob cache; hash synchronously, write asynchronously (WP-10 BlobStore.put). */
  storeBlob(data: Uint8Array | string, mediaType: string, name?: string | null): BlobRef;
  now(): Date;
}

/** Registered by the engine before send(): lets the normalizer create the user_message item (F.9). */
export interface PendingPrompt {
  messageUuid: string;
  text: string;
  attachments: BlobRef[];
  priority: 'next' | 'now';
  at: Date;
}

export type StatusSignal =
  | { type: 'session_state'; state: 'running' | 'requires_action' | 'idle' }
  | {
      type: 'init';
      sessionId: string;
      model: string;
      /** null = unknown mode of a newer CLI (R0-05). */
      permissionMode: PermissionMode | null;
      cliVersion: string;
      apiKeySource: string;
      capabilities: string[];
    }
  /**
   * Every new session_id, including the first one; after a reset the new id comes with the next
   * frames (F.7). Ids of a conversation ended by a reset never trigger this signal again (late
   * frames of the old conversation must not switch the new one back).
   */
  | { type: 'session_id'; sessionId: string }
  /** system/status.permissionMode; null = unknown mode of a newer CLI (R0-05). */
  | { type: 'permission_mode'; mode: PermissionMode | null }
  | { type: 'compacting'; active: boolean }
  | { type: 'retry'; active: boolean }
  /** F.6, main thread only. */
  | { type: 'assistant_model'; model: string }
  | { type: 'assistant_error'; error: ErrorPayload }
  /**
   * C.1 during the turn. `contextWindow` = `modelUsage[model].contextWindow` of the last `result`
   * of this normalizer (exact model, else the largest window), null before the first result – so
   * the engine never parses raw `result` messages itself (R1-07).
   */
  | { type: 'context_estimate'; totalTokens: number; model: string | null; contextWindow: number | null }
  | {
      type: 'turn_result';
      outcome: 'success' | 'error' | 'interrupted';
      durationMs: number;
      costUsdTotal: number | null;
      error: ErrorPayload | null;
      resultExcerpt: string | null;
      userMessageUuids: string[];
      /** num_turns 0 (/rename, /clear, F.7/F.8): changes neither lastTurn nor unread. */
      synthetic: boolean;
      /** `result.startup_failure_reason` was set (C.5, R0-05a); `error` carries its code. */
      startupFailure: boolean;
    }
  | { type: 'conversation_reset'; trigger: string | null; correlationId: string }
  /**
   * system/session_title_changed (untyped, F.8). The ENGINE decides (R0-05e): the echo of its own
   * pending `/rename X` (title === X) → title X, titleSource 'custom'; titleSource already
   * 'custom' → ignore; within the current turn after a conversation_reset → ignore (the CLI
   * echoes the old title for the new session); otherwise → title, titleSource 'ai'.
   */
  | { type: 'title_changed'; title: string }
  /** Non-ambient tasks. */
  | { type: 'background_tasks'; count: number }
  | { type: 'prompt_lifecycle'; messageUuid: string; state: 'queued' | 'started' | 'completed' | 'cancelled' }
  | { type: 'rate_limit'; info: RateLimitInfo }
  /** C.5: rejected project MCP servers. */
  | { type: 'mcp_servers'; notApproved: string[] };

export interface NormalizerOutput {
  ops: SessionOp[];
  signals: StatusSignal[];
}

export interface LiveNormalizer {
  push(message: unknown, receivedAt: Date): NormalizerOutput;
  /**
   * The user_message item is created on `command_lifecycle started` (F.9). Without the capability
   * `msg_lifecycle_v1` (older CLI, R0-29): when the uuid first appears in a status/result
   * `user_message_uuids`, at the latest with the next turn_result.
   */
  registerPrompt(prompt: PendingPrompt): void;
  /** Annotate the tool_call (status awaiting_decision / decision ref / outcome). */
  attachDecision(toolUseId: string, ref: ToolDecisionRef): NormalizerOutput;
  /** Close streaming items (turn abort, process exit). */
  finalizeOpen(reason: 'turn_end' | 'process_exit'): NormalizerOutput;
  /**
   * After conversation_reset: continue in the new conversation (the engine created the id).
   * Afterwards NO ops for items of older conversations are emitted (e.g. a background task of the
   * old conversation finishing) – they are only logged (R0-05f); `order` restarts at nextOrder.
   */
  startConversation(conversationId: ConversationId, nextOrder: number): void;
  readonly unknownCounts: Readonly<Record<string, number>>;
  readonly ignoredCounts: Readonly<Record<string, number>>;
}

export type CreateLiveNormalizer = (ctx: NormalizerContext) => LiveNormalizer;

export type NormalizeHistory = (
  messages: HistoryMessage[],
  ctx: NormalizerContext,
) => { items: TranscriptItem[]; unknownCounts: Record<string, number> };

export type NormalizeContextUsage = (
  raw: unknown,
  override: { contextWindow: number | null },
  at: Date,
  detail: 'summary' | 'full',
) => ContextBreakdown | null;

export type StatusEvent =
  | StatusSignal
  | { type: 'process_starting' }
  | { type: 'process_exit'; expected: boolean; error: ErrorPayload | null }
  | { type: 'decisions_changed'; decisions: StatusFacts['decisions'] }
  | { type: 'queue_changed'; count: number }
  /** Presence: session visible → unread=false. */
  | { type: 'viewed' }
  | { type: 'external'; active: boolean }
  /** When loading from the registry. */
  | { type: 'server_restart'; hadOpenDecisions: boolean }
  /** Phase 2 (ADR-112): sets StatusFacts.wakeupAt (scheduled "continue"); null clears it. */
  | { type: 'wakeup'; at: string | null };

export interface ReduceStatusContext {
  /** A client shows this session visibly (presence) → no unread. */
  viewedByVisibleClient: boolean;
  /** The current process has emitted at least one session_state signal (engine tracks it). */
  sessionStateSeen: boolean;
}

/**
 * Pure status reducer (WP-12, table-tested there). Mandatory rules (WP-02 §9.4 + R0-05):
 * - session_state running|requires_action → working; idle → idle (unread unchanged).
 * - turn_result (synthetic: no change of lastTurn/unread at all): lastTurn = {outcome, now,
 *   durationMs}; unread = true if outcome ≠ interrupted and !viewedByVisibleClient (otherwise
 *   unchanged). unread is set ONLY here, so result → idle and idle → result give the same facts
 *   (C.5 "beliebige Reihenfolge"); "done" still needs runState idle (deriveDisplayStatus).
 * - turn_result with startupFailure, or with an error of category setup → runState error,
 *   errorCode = error.code (fallback CLAUDE_STARTUP_FAILED); interrupted never sets errorCode.
 * - Without sessionStateSeen (old CLI) a non-synthetic turn_result also counts as idle.
 * - process_starting → starting; process_exit expected → sleeping; unexpected → error with the
 *   given error or CLAUDE_PROCESS_CRASHED – but an existing errorCode (runState error) is kept.
 * - assistant_error of category setup → error.
 * - server_restart: starting|working or open decisions → interrupted; idle → sleeping; otherwise
 *   unchanged (the engine then sends decisions_changed with the expired count → needs-resume).
 * - rate_limit rejected → rateLimitedUntil = resetsAt.
 * - wakeup (Phase 2) → wakeupAt = at; nothing else changes.
 */
export type ReduceStatus = (
  facts: StatusFacts,
  event: StatusEvent,
  now: Date,
  ctx: ReduceStatusContext,
) => StatusFacts;
