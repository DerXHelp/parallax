/**
 * WP-66: side questions (`/btw`, the CLI's internal `askSideQuestion`) of one entry. The engine owns
 * the `side_question` items (the normalizer never sees them): created `pending` in the current
 * conversation (an `order` claimed from the live normalizer, id `px:<conversationId>:<order>`),
 * updated once the answer arrives. Persisted in Parallax's transcript log like every other item –
 * the claude transcript never holds them (nothing is imported).
 *
 * - Thread: `threadId` = the id of the thread's first question; a follow-up sends the answered
 *   questions of its thread as `history` (oldest first, at most the last SIDE_HISTORY_MAX).
 * - Cancel: aborts the request and marks the item `cancelled` at once; a late answer is dropped.
 * - The process ends (close, sleep, crash): open side questions end `failed`. The server shutdown
 *   ends them the same way; an item still `pending` in a log (crash) is repaired when it is loaded.
 * - Delete: `item.remove` for every item of the thread (an open one is cancelled first).
 * - Side questions change neither unread, notifications, status nor `lastActivityAt`; an open one
 *   keeps the process awake (the idle sleep waits until it is answered).
 * - An answer that arrives after the conversation changed (/clear) goes into the log of the
 *   conversation it was asked in, without an op (the windows show the new conversation).
 */
import type { ConversationId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { SideQuestionItem } from '@shared/model';
import type { SideQuestionResult, SideQuestionTurn } from '../backend/types';
import { commandError, type EngineCore, type EntryState } from './entryState';
import type { SessionRuntime } from './runtime';

/** Answered questions of a thread sent along with a follow-up (the newest ones). */
export const SIDE_HISTORY_MAX = 10;

/** One open side question of the running process. */
export interface PendingSideQuestion {
  item: SideQuestionItem;
  conversationId: ConversationId;
  controller: AbortController;
  runtime: SessionRuntime;
}

/** Every item of the current conversation (log fold incl. unwritten lines; side questions only). */
async function sideItems(core: EngineCore, s: EntryState): Promise<SideQuestionItem[]> {
  const { items } = await core.stores.transcripts.readTail(s.id, s.conversationId(), Number.MAX_SAFE_INTEGER);
  return items.filter((item): item is SideQuestionItem => item.kind === 'side_question');
}

/** `history` of a follow-up: the answered (non-synthetic) questions of the thread, oldest first. */
export function threadHistory(items: readonly SideQuestionItem[], threadId: string): SideQuestionTurn[] {
  return items
    .filter(
      (item) =>
        item.threadId === threadId && item.status === 'answered' && item.response !== null && !item.synthetic,
    )
    .sort((a, b) => a.order - b.order)
    .slice(-SIDE_HISTORY_MAX)
    .map((item) => ({ question: item.question, response: item.response ?? '' }));
}

/** The finished item for a backend result. */
export function finishedItem(item: SideQuestionItem, result: SideQuestionResult, at: string): SideQuestionItem {
  const base = { ...item, retry: null };
  if (result.ok) {
    const answer = result.answer;
    return {
      ...base,
      status: 'answered',
      response: answer?.response ?? null,
      // No answer at all (no conversation state yet) is shown like a synthetic one.
      synthetic: answer === null ? true : answer.synthetic,
      fallbackModel: answer?.fallbackModel ?? null,
      error: null,
      answeredAt: at,
    };
  }
  if (result.reason === 'cancelled') return { ...base, status: 'cancelled' };
  return { ...base, status: 'failed', error: sideError(result.reason, item) };
}

function sideError(reason: 'unavailable' | 'busy' | 'failed', item: SideQuestionItem): ErrorPayload {
  if (reason === 'busy') return makeError('SESSION_BUSY', { reason: 'side_question_busy', itemId: item.id });
  return makeError('CLAUDE_CONTROL_FAILED', { method: 'askSideQuestion', reason });
}

/** The process (or the server) ended while the question was open. */
function endedError(s: EntryState, reason: 'exited' | 'shutdown'): ErrorPayload {
  return makeError('SESSION_NOT_RUNNING', { entryId: s.id, reason });
}

/** Publishes (current conversation) or only logs (an older one) the changed item. */
function publish(core: EngineCore, s: EntryState, conversationId: ConversationId, item: SideQuestionItem): void {
  if (s.removed) return;
  if (s.conversationId() === conversationId) {
    s.emit([{ op: 'item.upsert', item }]);
    return;
  }
  core.stores.transcripts.append(s.id, conversationId, { v: 1, at: core.now().toISOString(), op: 'upsert', item });
}

/**
 * `session.askSideQuestion` (inside the lifecycle lock, the process runs): the `pending` item at once,
 * the request in the background. Returns the item id.
 */
export async function askSideQuestion(
  core: EngineCore,
  s: EntryState,
  question: string,
  threadId: string | null,
): Promise<string> {
  const history = threadId === null ? [] : threadHistory(await sideItems(core, s), threadId);
  const runtime = s.runtime;
  if (runtime === null || !runtime.alive || runtime.closing) {
    throw commandError('SESSION_NOT_RUNNING', { entryId: s.id });
  }
  const conversationId = s.conversationId();
  const order = runtime.normalizer.claimOrder();
  const id = `px:${conversationId}:${String(order)}`;
  const item: SideQuestionItem = {
    id,
    order,
    at: core.now().toISOString(),
    parentToolUseId: null,
    kind: 'side_question',
    threadId: threadId ?? id,
    question,
    status: 'pending',
    response: null,
    synthetic: false,
    fallbackModel: null,
    retry: null,
    error: null,
    answeredAt: null,
  };
  const pending: PendingSideQuestion = { item, conversationId, controller: new AbortController(), runtime };
  s.sideQuestions.set(id, pending);
  s.emit([{ op: 'item.upsert', item }]);
  core.log.info({ entryId: s.id, itemId: id, followUp: threadId !== null, history: history.length }, 'side question');
  void run(core, s, pending, history);
  return id;
}

async function run(
  core: EngineCore,
  s: EntryState,
  pending: PendingSideQuestion,
  history: readonly SideQuestionTurn[],
): Promise<void> {
  const id = pending.item.id;
  let result: SideQuestionResult;
  try {
    result = await pending.runtime.agent.askSideQuestion(pending.item.question, {
      history,
      signal: pending.controller.signal,
      onRetry: (retry) => {
        const current = s.sideQuestions.get(id);
        if (current === undefined) return;
        current.item = { ...current.item, retry };
        publish(core, s, current.conversationId, current.item);
      },
    });
  } catch (error) {
    // The port never rejects; a broken backend still ends the question.
    core.reportError(error, 'askSideQuestion');
    result = { ok: false, reason: 'failed' };
  }
  const current = s.sideQuestions.get(id);
  // Cancelled, deleted or ended with the process meanwhile: that state stays.
  if (current !== pending) return;
  s.sideQuestions.delete(id);
  if (!result.ok && result.reason !== 'cancelled') {
    core.log.warn({ entryId: s.id, itemId: id, reason: result.reason }, 'side question failed');
  }
  publish(core, s, pending.conversationId, finishedItem(pending.item, result, core.now().toISOString()));
  // An idle sleep held back by this question may go now.
  core.considerSleep(s);
}

/** `session.cancelSideQuestion`: an open question ends `cancelled` at once; anything else: no-op. */
export function cancelSideQuestion(core: EngineCore, s: EntryState, itemId: string): void {
  const pending = s.sideQuestions.get(itemId);
  if (pending === undefined) return;
  s.sideQuestions.delete(itemId);
  pending.controller.abort();
  publish(core, s, pending.conversationId, { ...pending.item, status: 'cancelled', retry: null });
  core.considerSleep(s);
}

/** `session.deleteSideQuestion`: every item of the thread leaves Parallax (`item.remove`). */
export async function deleteSideQuestionThread(core: EngineCore, s: EntryState, threadId: string): Promise<void> {
  const conversationId = s.conversationId();
  const items = (await sideItems(core, s)).filter((item) => item.threadId === threadId);
  const ids = new Set(items.map((item) => item.id));
  for (const [id, pending] of s.sideQuestions) {
    if (pending.item.threadId !== threadId) continue;
    s.sideQuestions.delete(id);
    pending.controller.abort();
    if (pending.conversationId === conversationId) ids.add(id);
  }
  if (ids.size === 0 || s.removed || s.conversationId() !== conversationId) return;
  s.emit([...ids].map((itemId) => ({ op: 'item.remove' as const, itemId })));
  core.considerSleep(s);
}

/**
 * The process of `runtime` ended (or the server shuts down: `runtime` null = every open question):
 * open side questions end `failed` (never left pending).
 */
export function endSideQuestions(
  core: EngineCore,
  s: EntryState,
  runtime: SessionRuntime | null,
  reason: 'exited' | 'shutdown',
): void {
  for (const [id, pending] of s.sideQuestions) {
    if (runtime !== null && pending.runtime !== runtime) continue;
    s.sideQuestions.delete(id);
    pending.controller.abort();
    publish(core, s, pending.conversationId, {
      ...pending.item,
      status: 'failed',
      retry: null,
      error: endedError(s, reason),
    });
  }
}
