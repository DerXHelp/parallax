/**
 * "Implement with a fresh context" (Phase 3, ADR-147; WP-50 §4.12 `decision.respond`
 * `approve_fresh_context`): a new CLI session in the same entry instead of a `/clear` emulation.
 *
 * Checks: open or expired plan decision (`DECISION_*`), `mode ∈ approveModes`
 * (`DECISION_OPTION_UNAVAILABLE`), bypass only with the profile's permission (`MODE_NOT_ALLOWED`,
 * commands.ts), otherwise "without work": no further open decision, nothing queued, no non-ambient
 * background task (`SESSION_BUSY`). Only an accepted request (gate and checks inside the lifecycle
 * lock passed) cancels a scheduled auto-retry (CR3-08, like the A.10 approval). Then, in the lock:
 * 1. the open request gets deny + interrupt ("The user chose to implement the plan in a fresh
 *    session.") – an expired card is only closed;
 * 2. outcome `plan_approved{mode, edited, freshContext:true}`; plans/v<N>.md is ensured;
 * 3. the CLI ends the denied turn with its `result` (cost and usage of the planning turn, WP61-03)
 *    – awaited at most `freshContextResultMs`; then the process is closed, the conversation ends
 *    with `fresh_session`;
 * 4. a new conversation starts WITHOUT resume (same profile, model, effort, fast mode;
 *    `permissionMode` = `mode`): op `conversation.reset{trigger:'fresh_session', hasEarlier:true}`;
 * 5. first prompt `Implement the following approved plan.` + `Plan file: <path>` (when known) + an
 *    empty line + the plan (or `editedPlan`) with its `@` mentions neutralized (WP61-01);
 *    `OutgoingPrompt` has no `client_composed`.
 * A start failure ends like any failed start (status `error`, px item, lastError) and the command
 * fails with its code; the old conversation stays reachable via `session.switchConversation`. While
 * the flow runs every further `decision.respond` of the entry answers SESSION_BUSY (double click).
 */
import type { ClientId, DecisionId } from '@shared/common';
import type { DecisionResponse, PlanDecision, PlanResponse } from '@shared/model';
import type { CommandResult } from '@shared/protocol';
import { cancelContinue } from './continuePlan';
import { assertEntryGate, commandError, type EngineCore, type EntryState } from './entryState';
import { settledWithin } from './lib/timers';
import { closeRuntime, deliverPrompt, startRuntime } from './runtime';
import { bridgeOf } from './remoteControl';
import { freshContextPrompt, newConversation } from './summary';

export interface FreshContextRequest {
  decisionId: DecisionId;
  /** The whole intent (broker checks) … */
  response: Extract<DecisionResponse, { kind: 'plan' }>;
  /** … and its fresh-context part (mode, editedPlan). */
  approval: Extract<PlanResponse, { behavior: 'approve_fresh_context' }>;
}

export async function approveFreshContext(
  core: EngineCore,
  s: EntryState,
  request: FreshContextRequest,
  clientId: ClientId,
): Promise<CommandResult<'decision.respond'>> {
  if (s.freshContextRunning) throw commandError('SESSION_BUSY', { entryId: s.id });
  // The decision checks first (DECISION_*), again inside the lock.
  s.broker.check(request.decisionId, request.response);
  s.freshContextRunning = true;
  try {
    return await s.lifecycle.run(async () => {
      assertEntryGate(s, 'decision.respond');
      s.broker.check(request.decisionId, request.response);
      assertWithoutOtherWork(s, request.decisionId);
      // CR3-08: accepted – from here on no automatic restart of a crashed process.
      s.cancelRetry();
      // WP61-03: an open request belongs to a running turn; the deny ends it with a `result`.
      const open = s.broker.open().some((d) => d.id === request.decisionId);
      const turnEnd = open && s.runtime !== null ? s.runtime.nextTurnResult() : null;
      const result = s.broker.respond(request.decisionId, request.response, clientId);
      if (result.kind !== 'fresh-context') throw new Error(`fresh context: unexpected ${result.kind}`);
      const { decision, outcome } = result;
      const plan = request.approval.editedPlan ?? decision.plan;
      const planFilePath = decision.planFilePath ?? s.detailFields().planFile?.path ?? null;
      await ensurePlanStored(core, s, decision);
      // ADR-112: a scheduled "continue" belongs to the conversation that ends.
      cancelContinue(s);
      if (
        turnEnd !== null &&
        !(await settledWithin(core.timers, turnEnd, core.options.freshContextResultMs))
      ) {
        core.log.info({ entryId: s.id }, 'fresh context: no result of the denied turn – closing without it');
      }
      await closeRuntime(s, core, 'fresh_context');
      // Expired cards (A.10) belong to the conversation that ends.
      s.broker.closeExpired(clientId);
      startFreshConversation(core, s);
      s.patch((e) => (e.permissionMode === outcome.mode ? e : { ...e, permissionMode: outcome.mode }));
      core.log.info({ entryId: s.id, mode: outcome.mode, edited: outcome.edited }, 'fresh context: starting');
      await startRuntime(s, core, { byClientId: clientId, permissionMode: outcome.mode });
      deliverPrompt(s, core, freshContextPrompt(planFilePath, plan), 'next');
      return { outcome };
    });
  } finally {
    s.freshContextRunning = false;
  }
}

/**
 * §4.12 "ohne Arbeit" for a fresh context: the plan decision itself may be open (its turn waits for
 * it), but no other decision, nothing queued and no non-ambient background task.
 */
function assertWithoutOtherWork(s: EntryState, decisionId: DecisionId): void {
  const f = s.facts;
  if (
    s.broker.open().some((d) => d.id !== decisionId) ||
    s.queue.count() > 0 ||
    f.queuedPrompts > 0 ||
    f.backgroundTasks > 0
  ) {
    throw commandError('SESSION_BUSY', { entryId: s.id });
  }
}

/** The plan version is stored (the broker writes it fire-and-forget when the decision comes). */
async function ensurePlanStored(core: EngineCore, s: EntryState, decision: PlanDecision): Promise<void> {
  try {
    const stored = await core.stores.decisions.readPlan(s.id, decision.version);
    if (stored === null) await core.stores.decisions.savePlan(s.id, decision.version, decision.plan);
  } catch (error) {
    core.log.warn({ err: error, entryId: s.id, version: decision.version }, 'fresh context: plan not stored');
  }
}

/**
 * Ends the current conversation with `fresh_session` (its title saved) and appends a new one
 * without a Claude session (the next start does not resume). The entry keeps its title (the same
 * work continues); the gauge belonged to the old conversation.
 */
function startFreshConversation(core: EngineCore, s: EntryState): void {
  const at = core.now().toISOString();
  const previous = s.conversation();
  const conversationId = core.ids.newId('cv');
  s.patch((e) => ({
    ...e,
    conversations: [
      ...e.conversations.slice(0, -1),
      {
        ...previous,
        endedAt: at,
        endReason: 'fresh_session' as const,
        title: e.title === '' ? null : e.title,
      },
      // WP-64: the entry's remote session continues (reattach at the next start).
      newConversation(conversationId, at, null, bridgeOf(previous)),
    ],
    context: null,
    contextPct: null,
  }));
  s.promptTitle = null;
  s.pendingRename = null;
  s.resetInTurn = false;
  s.lastSdkMaxTokens = null;
  s.emit([
    {
      op: 'conversation.reset',
      conversationId,
      previousConversationId: previous.id,
      trigger: 'fresh_session',
      hasEarlier: true,
    },
    { op: 'detail.patch', patch: { conversationId, conversations: s.entry.conversations } },
  ]);
}
