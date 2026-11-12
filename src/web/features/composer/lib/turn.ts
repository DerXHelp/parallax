import type { TranscriptItem } from '@shared/model';
import type { StatusFacts } from '@shared/status';

/**
 * Does a turn run, or only background tasks (B18, ADR-159)? While only a background agent or shell
 * works, the CLI still reports work (`runState: 'working'`), but no turn runs: it answers a
 * queued and an immediate prompt alike, right away, and an interrupt does nothing (WP-61 §2.3).
 * The composer then offers a plain "Send" and no Stop – tasks are stopped in the task panel.
 *
 * Derived from existing facts only (no contract change): the status facts of the summary and the
 * transcript, where every turn ends with a `turn_result` item (top level, after its prompt and
 * replies). When in doubt it says "turn runs" – the composer then behaves as before.
 */

export type TurnFacts = Pick<
  StatusFacts,
  'runState' | 'backgroundTasks' | 'queuedPrompts' | 'compacting' | 'retrying'
>;

/**
 * The summary part: the CLI works, background tasks run, nothing is queued, compacting or retried.
 * Whether a turn runs as well decides `lastTurnEnded`.
 */
export function workOnlyInBackground(facts: TurnFacts): boolean {
  return (
    facts.runState === 'working' &&
    facts.backgroundTasks > 0 &&
    facts.queuedPrompts === 0 &&
    !facts.compacting &&
    !facts.retrying
  );
}

const endedCache = new WeakMap<readonly TranscriptItem[], boolean>();

/**
 * The transcript part: the main agent's newest exchange is a finished turn – a `turn_result` comes
 * after the last prompt, reply or tool call of the main agent. Subagent items (a background agent
 * writes on after its launching turn ended) do not count; a task notification the CLI is about to
 * answer starts a turn. No `turn_result` at all (trimmed transcript) → not ended.
 */
export function lastTurnEnded(items: readonly TranscriptItem[]): boolean {
  const cached = endedCache.get(items);
  if (cached !== undefined) return cached;
  let ended = false;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.parentToolUseId !== null) continue;
    if (item.kind === 'turn_result') {
      ended = true;
      break;
    }
    if (item.kind !== 'system' || item.event === 'task_notification') break;
  }
  endedCache.set(items, ended);
  return ended;
}

/** Only background tasks work, no turn: plain "Send", no Stop, no "Send now" (B18). */
export function onlyBackgroundWork(
  facts: TurnFacts,
  items: readonly TranscriptItem[],
  queuedInDetail: number,
): boolean {
  return workOnlyInBackground(facts) && queuedInDetail === 0 && lastTurnEnded(items);
}
