/**
 * Port: normalizer + status machine (WP-12) ↔ session engine (WP-13). Types only; frozen like
 * src/shared. Design: docs/wp/WP-02.md §9.4.
 *
 * WP-12 modules (fixed names): sessions/normalizer/index.ts exports createLiveNormalizer,
 * normalizeHistory, normalizeContextUsage; sessions/normalizer/sdk-schemas.ts (tolerant zod
 * schemas of SDK messages); sessions/status/machine.ts exports reduceStatus.
 *
 * Single writer per SessionDetail field: normalizer → init, backgroundTasks, promptSuggestion,
 * rateLimit, commands, unknownCounts; engine → conversationId, conversations, queue, models.
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
      permissionMode: PermissionMode;
      cliVersion: string;
      apiKeySource: string;
      capabilities: string[];
    }
  /** First message with a new session_id after a reset (F.7). */
  | { type: 'session_id'; sessionId: string }
  /** system/status.permissionMode */
  | { type: 'permission_mode'; mode: PermissionMode }
  | { type: 'compacting'; active: boolean }
  | { type: 'retry'; active: boolean }
  /** F.6, main thread only. */
  | { type: 'assistant_model'; model: string }
  | { type: 'assistant_error'; error: ErrorPayload }
  /** C.1 during the turn. */
  | { type: 'context_estimate'; totalTokens: number; model: string | null }
  | {
      type: 'turn_result';
      outcome: 'success' | 'error' | 'interrupted';
      durationMs: number;
      costUsdTotal: number | null;
      error: ErrorPayload | null;
      resultExcerpt: string | null;
      userMessageUuids: string[];
      synthetic: boolean;
    }
  | { type: 'conversation_reset'; trigger: string | null; correlationId: string }
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
  registerPrompt(prompt: PendingPrompt): void;
  /** Annotate the tool_call (status awaiting_decision / decision ref / outcome). */
  attachDecision(toolUseId: string, ref: ToolDecisionRef): NormalizerOutput;
  /** Close streaming items (turn abort, process exit). */
  finalizeOpen(reason: 'turn_end' | 'process_exit'): NormalizerOutput;
  /** After conversation_reset: continue in the new conversation (the engine created the id). */
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
  | { type: 'server_restart'; hadOpenDecisions: boolean };

/**
 * Pure status reducer (WP-12, table-tested there). Mandatory rules (§9.4):
 * session_state running|requires_action → working; idle → idle (+ unread=true if
 * lastTurn.outcome ≠ interrupted and !viewedByVisibleClient); turn_result only sets lastTurn
 * (errorCode stays null for interrupted); process_starting → starting; process_exit expected →
 * sleeping, unexpected → error (CLAUDE_PROCESS_CRASHED or the given error); assistant_error of
 * category setup → error; server_restart: starting|working or open decisions → interrupted,
 * idle → sleeping, otherwise unchanged; rate_limit rejected → rateLimitedUntil = resetsAt;
 * without any session_state signal seen so far (old CLI) turn_result also counts as idle.
 */
export type ReduceStatus = (
  facts: StatusFacts,
  event: StatusEvent,
  now: Date,
  ctx: { viewedByVisibleClient: boolean },
) => StatusFacts;
