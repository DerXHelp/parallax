/**
 * PermissionBroker (WP-13 §3.4, ADR-012, A.2, A.6, A.10, R0-07): exactly one `Decision` per
 * `canUseTool` request of one entry, a queue of open decisions (main agent sequentially,
 * subagents in parallel), "first click wins" decided synchronously, the server-built
 * `PermissionResult`, persistence (open records with snapshot) and `expired` cards after a
 * restart. A server shutdown (`freeze`) never cancels: open records stay open → expired.
 */
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type {
  ClientId,
  ConversationId,
  DecisionId,
  DecisionKind,
  EntryId,
  JsonValue,
  PermissionMode,
} from '@shared/common';
import { makeError } from '@shared/errors';
import type {
  Decision,
  DecisionOutcome,
  DecisionRecord,
  DecisionResponse,
  PlanDecision,
  Requester,
  ToolCallItem,
  ToolDecisionRef,
  Truncation,
} from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import type { DecisionCounts } from '@shared/status';
import type { PermissionHandler, PermissionRequest } from '../backend/types';
import { logger } from '../lib/logger';
import { CommandError, type DecisionStore } from '../sync/ports';
import {
  approveModes,
  buildOffer,
  buildResult,
  cancelResult,
  decisionKindFor,
  parsePlan,
  parseQuestions,
  validateResponse,
  type CancelReason,
} from './brokerRules';

export type { CancelReason } from './brokerRules';

const log = logger.child({ module: 'broker' });

/** Resolved records kept in decisions.json besides all open ones. */
export const DEFAULT_RECORDS_KEEP = 200;

export interface BrokerDeps {
  entryId: EntryId;
  now(): Date;
  newDecisionId(): DecisionId;
  store: DecisionStore;
  /** Current conversation (changes on /clear). */
  conversationId(): ConversationId;
  /** Actual mode (offer.acceptEdits). */
  permissionMode(): PermissionMode | null;
  /** ProfileSummary.allowsBypass (R0-09). */
  allowsBypass(): boolean;
  /** detail.models of the current model. */
  supportsAutoMode(): boolean;
  /** From the mirror (requester, capped input). */
  findToolCall(toolUseId: string): ToolCallItem | null;
  capInput(input: Record<string, unknown>): { input: JsonValue; truncated: Truncation | null };
  /** decision.upsert / decision.resolved. */
  emit(ops: SessionOp[]): void;
  /** → normalizer + emit; no-op without a live normalizer. */
  attachDecision(toolUseId: string, ref: ToolDecisionRef): void;
  onCountsChanged(counts: DecisionCounts, addedKind: DecisionKind | null): void;
  /** Resolved records kept (default 200). */
  recordsKeep?: number;
}

export type RespondResult =
  | { kind: 'resolved'; outcome: DecisionOutcome }
  /**
   * expired plan + approve: the decision is now CLAIMED (a second respond → DECISION_ALREADY_RESOLVED,
   * closeExpired skips it); the manager resumes, then calls resolveExpired (A.10, diagram g).
   */
  | { kind: 'resume-and-approve'; decision: PlanDecision; mode: PermissionMode };

export interface Broker {
  /** StartSessionRequest.canUseTool */
  readonly handler: PermissionHandler;
  /** Synchronous check-and-set: first click wins. Throws CommandError. */
  respond(decisionId: DecisionId, response: DecisionResponse, byClientId: ClientId | null): RespondResult;
  resolveExpired(decisionId: DecisionId, outcome: DecisionOutcome, byClientId: ClientId | null): void;
  /** Resume failed → clickable again. */
  releaseExpired(decisionId: DecisionId): void;
  /** Cancel open decisions; 'deny-interrupt' answers the SDK with {deny, interrupt:true}. */
  cancel(scope: 'all' | 'main', reason: CancelReason, answer: 'deny' | 'deny-interrupt'): void;
  /** Server start: open records → expired cards (with snapshot) or counted-only (without). */
  restore(records: DecisionRecord[]): { hadOpen: boolean };
  /** Session start: every expired card → decision.resolved {expired}; counter → 0. */
  closeExpired(byClientId: ClientId | null): void;
  /** By createdAt. */
  open(): Decision[];
  expired(): Decision[];
  counts(): DecisionCounts;
  /** Shutdown: stop persisting and cancelling (open records stay open → expired after restart). */
  freeze(): void;
}

type Status = 'open' | 'expired' | 'claimed' | 'resolved';

interface Pending {
  /** Uncapped original input of the canUseTool request (updatedInput is built from it). */
  input: Record<string, unknown>;
  resolve(result: PermissionResult): void;
  detach(): void;
}

interface Slot {
  /** null only for resolved records restored without snapshot. */
  decision: Decision | null;
  record: DecisionRecord;
  status: Status;
  /** Live canUseTool request (open decisions of this process only). */
  pending: Pending | null;
}

function stringField(value: JsonValue | undefined, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

function recordOf(decision: Decision): DecisionRecord {
  return {
    id: decision.id,
    kind: decision.kind,
    conversationId: decision.conversationId,
    toolUseId: decision.toolUseId,
    toolName: decision.toolName,
    requester: decision.requester,
    createdAt: decision.createdAt,
    resolvedAt: null,
    outcome: null,
    planVersion: decision.kind === 'plan' ? decision.version : null,
    planFilePath: decision.kind === 'plan' ? decision.planFilePath : null,
    decision,
  };
}

function refOf(record: DecisionRecord, outcome: DecisionOutcome | null): ToolDecisionRef {
  return { decisionId: record.id, kind: record.kind, planVersion: record.planVersion, outcome };
}

export function createBroker(deps: BrokerDeps): Broker {
  const keep = deps.recordsKeep ?? DEFAULT_RECORDS_KEEP;
  /** Decisions in creation order: open, expired, claimed and the kept resolved ones. */
  const slots = new Map<DecisionId, Slot>();
  /** Resolved records in resolution order (oldest first), trimmed to `keep`. */
  const resolvedOrder: DecisionId[] = [];
  /** Restored records without snapshot: closed at once, only counted until closeExpired (A.10). */
  let countedOnly = 0;
  let planVersion = 0;
  let lastPlan: { conversationId: ConversationId; text: string } | null = null;
  let frozen = false;

  const persist = (): void => {
    if (frozen) return;
    try {
      deps.store.save(
        deps.entryId,
        [...slots.values()].map((slot) => slot.record),
      );
    } catch (error) {
      log.error({ err: error, entryId: deps.entryId }, 'saving decisions failed');
    }
  };

  /** The record of the newest plan version: after a restart the versions continue from it (R2-09). */
  const isNewestPlan = (id: DecisionId): boolean => {
    const version = slots.get(id)?.record.planVersion ?? null;
    return version !== null && version === planVersion;
  };

  const markResolved = (id: DecisionId): void => {
    resolvedOrder.push(id);
    while (resolvedOrder.length > keep) {
      // Oldest first, but never the newest plan record (§6 Nr. 4: plan versions stay monotonic).
      const index = resolvedOrder.findIndex((candidate) => !isNewestPlan(candidate));
      if (index < 0) break;
      const [oldest] = resolvedOrder.splice(index, 1);
      if (oldest !== undefined) slots.delete(oldest);
    }
  };

  const counts = (): DecisionCounts => {
    const result: DecisionCounts = {
      permission: 0,
      question: 0,
      plan: 0,
      oldestKind: null,
      expired: countedOnly,
    };
    for (const slot of slots.values()) {
      if (slot.status === 'open') {
        result[slot.record.kind] += 1;
        result.oldestKind ??= slot.record.kind;
      } else if (slot.status === 'expired' || slot.status === 'claimed') {
        result.expired += 1;
      }
    }
    return result;
  };

  const notifyCounts = (addedKind: DecisionKind | null): void => {
    deps.onCountsChanged(counts(), addedKind);
  };

  /** Common end of every decision: answer the SDK, op, tool-call ref, record (not saved here). */
  const finish = (
    slot: Slot,
    outcome: DecisionOutcome,
    byClientId: ClientId | null,
    result: PermissionResult | null,
  ): void => {
    slot.status = 'resolved';
    const pending = slot.pending;
    slot.pending = null;
    if (pending !== null) {
      pending.detach();
      if (result !== null) pending.resolve(result);
    }
    const at = deps.now().toISOString();
    // The outcome first (tool_call.decision via item.upsert), then the removal: a window that sees
    // the decision disappear already knows why ("allowed in another window", WP-20c). The other
    // order could reach the client in two animation frames – it showed "no longer open" instead.
    deps.attachDecision(slot.record.toolUseId, refOf(slot.record, outcome));
    deps.emit([{ op: 'decision.resolved', decisionId: slot.record.id, outcome, byClientId, at }]);
    slot.record = { ...slot.record, outcome, resolvedAt: at, decision: null };
    markResolved(slot.record.id);
  };

  const requesterFor = (req: PermissionRequest, toolCall: ToolCallItem | null): Requester => {
    const parentToolUseId = toolCall?.parentToolUseId ?? null;
    if (req.agentId === null && parentToolUseId === null) return { kind: 'main' };
    const agentCall = parentToolUseId === null ? null : deps.findToolCall(parentToolUseId);
    return {
      kind: 'subagent',
      agentId: req.agentId ?? parentToolUseId ?? '',
      description: stringField(agentCall?.input, 'description'),
      parentToolUseId,
    };
  };

  const buildDecision = (req: PermissionRequest): Decision => {
    const toolCall = deps.findToolCall(req.toolUseId);
    const base = {
      id: deps.newDecisionId(),
      entryId: deps.entryId,
      conversationId: deps.conversationId(),
      toolUseId: req.toolUseId,
      toolName: req.toolName,
      requester: requesterFor(req, toolCall),
      createdAt: deps.now().toISOString(),
      state: 'open' as const,
    };
    const kind = decisionKindFor(req.toolName);
    if (kind === 'question') {
      const questions = parseQuestions(req.input);
      if (questions !== null) return { ...base, kind: 'question', questions };
      log.warn({ toolUseId: req.toolUseId }, 'AskUserQuestion input unusable – permission card instead');
    }
    if (kind === 'plan') {
      const plan = parsePlan(req.input);
      if (plan !== null) {
        planVersion += 1;
        const version = planVersion;
        const previousVersionPlan =
          lastPlan !== null && lastPlan.conversationId === base.conversationId ? lastPlan.text : null;
        lastPlan = { conversationId: base.conversationId, text: plan.plan };
        deps.store.savePlan(deps.entryId, version, plan.plan).catch((error: unknown) => {
          log.error({ err: error, entryId: deps.entryId, version }, 'saving plan failed');
        });
        return {
          ...base,
          kind: 'plan',
          plan: plan.plan,
          planFilePath: plan.planFilePath,
          version,
          previousVersionPlan,
          approveModes: approveModes({
            supportsAutoMode: deps.supportsAutoMode(),
            allowsBypass: deps.allowsBypass(),
          }),
        };
      }
      log.warn({ toolUseId: req.toolUseId }, 'ExitPlanMode without plan text – permission card instead');
    }
    const capped =
      toolCall === null
        ? deps.capInput(req.input)
        : { input: toolCall.input, truncated: toolCall.inputTruncated };
    return {
      ...base,
      kind: 'permission',
      input: capped.input,
      inputTruncated: capped.truncated,
      title: req.title,
      displayName: req.displayName,
      description: req.description,
      decisionReason: req.decisionReason,
      decisionReasonType: req.decisionReasonType,
      blockedPath: req.blockedPath,
      mcpServer: req.mcpServer,
      offer: buildOffer(req, deps.permissionMode()),
    };
  };

  const handler: PermissionHandler = (req, signal) => {
    if (signal.aborted) return Promise.resolve(cancelResult('signal_aborted', 'deny'));
    const decision = buildDecision(req);
    const slot: Slot = { decision, record: recordOf(decision), status: 'open', pending: null };
    const promise = new Promise<PermissionResult>((resolve) => {
      const onAbort = (): void => {
        if (slot.status !== 'open') return;
        if (frozen) {
          // Shutdown: never cancel (stays open → expired after the restart), only release the SDK.
          slot.pending = null;
          resolve(cancelResult('signal_aborted', 'deny'));
          return;
        }
        // The CLI cancelled the request: the card disappears (decision.resolved cancelled).
        finish(
          slot,
          { type: 'cancelled', reason: 'signal_aborted' },
          null,
          cancelResult('signal_aborted', 'deny'),
        );
        persist();
        notifyCounts(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      slot.pending = {
        input: req.input,
        resolve,
        detach: () => {
          signal.removeEventListener('abort', onAbort);
        },
      };
    });
    slots.set(decision.id, slot);
    persist();
    deps.emit([{ op: 'decision.upsert', decision }]);
    deps.attachDecision(decision.toolUseId, refOf(slot.record, null));
    notifyCounts(decision.kind);
    return promise;
  };

  const claimedSlot = (decisionId: DecisionId): Slot | null => {
    const slot = slots.get(decisionId);
    if (slot?.status !== 'claimed') {
      log.warn({ decisionId, status: slot?.status ?? null }, 'expired decision is not claimed');
      return null;
    }
    return slot;
  };

  return {
    handler,

    respond(decisionId, response, byClientId) {
      const slot = slots.get(decisionId);
      if (slot !== undefined && (slot.status === 'resolved' || slot.status === 'claimed')) {
        throw new CommandError(makeError('DECISION_ALREADY_RESOLVED', { decisionId }));
      }
      const decision = slot?.decision ?? null;
      const error = validateResponse(decision === null ? undefined : { decision, resolved: false }, response);
      if (error !== null) throw new CommandError(error);
      if (slot === undefined || decision === null) throw new CommandError(makeError('DECISION_NOT_FOUND'));

      if (slot.status === 'expired') {
        // validateResponse lets only plan approve through for an expired card (diagram g).
        if (
          decision.kind !== 'plan' ||
          response.kind !== 'plan' ||
          response.response.behavior !== 'approve'
        ) {
          throw new CommandError(makeError('DECISION_EXPIRED', { decisionId }));
        }
        slot.status = 'claimed';
        return { kind: 'resume-and-approve', decision, mode: response.response.mode };
      }

      const pending = slot.pending;
      if (pending === null) throw new CommandError(makeError('DECISION_ALREADY_RESOLVED', { decisionId }));
      const built = buildResult(decision, pending.input, response);
      finish(slot, built.outcome, byClientId, built.result);
      persist();
      notifyCounts(null);
      return { kind: 'resolved', outcome: built.outcome };
    },

    resolveExpired(decisionId, outcome, byClientId) {
      const slot = claimedSlot(decisionId);
      if (slot === null) return;
      finish(slot, outcome, byClientId, null);
      persist();
      notifyCounts(null);
    },

    releaseExpired(decisionId) {
      const slot = claimedSlot(decisionId);
      if (slot !== null) slot.status = 'expired';
    },

    cancel(scope, reason, answer) {
      if (frozen) return;
      const targets = [...slots.values()].filter(
        (slot) => slot.status === 'open' && (scope === 'all' || slot.record.requester.kind === 'main'),
      );
      if (targets.length === 0) return;
      for (const slot of targets)
        finish(slot, { type: 'cancelled', reason }, null, cancelResult(reason, answer));
      persist();
      notifyCounts(null);
    },

    restore(records) {
      let hadOpen = false;
      const sorted = [...records].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      for (const record of sorted) {
        const snapshotVersion = record.decision?.kind === 'plan' ? record.decision.version : 0;
        planVersion = Math.max(planVersion, record.planVersion ?? 0, snapshotVersion);
        if (record.outcome !== null) {
          slots.set(record.id, {
            decision: null,
            record: { ...record, decision: null },
            status: 'resolved',
            pending: null,
          });
          markResolved(record.id);
          continue;
        }
        hadOpen = true;
        if (record.decision !== null) {
          const decision: Decision = { ...record.decision, state: 'expired' };
          slots.set(record.id, {
            decision,
            record: { ...record, decision },
            status: 'expired',
            pending: null,
          });
          if (decision.kind === 'plan')
            lastPlan = { conversationId: decision.conversationId, text: decision.plan };
          continue;
        }
        // Without snapshot: no card, closed as expired right away and only counted (R0-07).
        countedOnly += 1;
        const closed: DecisionRecord = {
          ...record,
          outcome: { type: 'expired' },
          resolvedAt: deps.now().toISOString(),
        };
        slots.set(record.id, { decision: null, record: closed, status: 'resolved', pending: null });
        markResolved(record.id);
      }
      if (countedOnly > 0) persist();
      return { hadOpen };
    },

    closeExpired(byClientId) {
      const targets = [...slots.values()].filter((slot) => slot.status === 'expired');
      const hadCounted = countedOnly > 0;
      countedOnly = 0;
      for (const slot of targets) finish(slot, { type: 'expired' }, byClientId, null);
      if (targets.length === 0 && !hadCounted) return;
      persist();
      notifyCounts(null);
    },

    open: () => decisionsWith(slots, ['open']),
    expired: () => decisionsWith(slots, ['expired', 'claimed']),
    counts,

    freeze() {
      frozen = true;
    },
  };
}

function decisionsWith(slots: ReadonlyMap<DecisionId, Slot>, statuses: readonly Status[]): Decision[] {
  const out: Decision[] = [];
  for (const slot of slots.values()) {
    if (slot.decision !== null && statuses.includes(slot.status)) out.push(slot.decision);
  }
  return out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
