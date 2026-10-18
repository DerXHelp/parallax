/**
 * "Continue after the rate limit" (Phase 2, ADR-112; WP-30 §4.12, architecture §5.2):
 * `session.continueAfterLimit {enabled:true}` plans the prompt `continue` for `rateLimitedUntil`
 * (now if that is not in the future) – persisted as `Entry.continueAt`, visible as
 * `StatusFacts.wakeupAt` (status event `wakeup`, display row 9 "background", no idle sleep
 * meanwhile). When due: `wakeup null`, `continueAt null`, resume if needed, then `continue` with
 * priority `next`. `enabled:false`, every own prompt (`sendPrompt`), archiving and the handoff to
 * an external console cancel the plan. Server start: a future plan gets its timer again, one at
 * most `continueGraceMs` overdue is sent at once, an older one is dropped.
 */
import type { EngineCore, EntryState } from './entryState';
import { deliverPrompt, startRuntime } from './runtime';

/** The prompt of a scheduled continue (what a user would type after the limit). */
export const CONTINUE_PROMPT = 'continue';

/** setTimeout's upper bound (≈ 24.8 days); a later plan re-arms itself when this fires. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Plans `continue` at `rateLimitedUntil` (if still in the future) or now; replaces an older plan.
 * Returns the planned time (ISO).
 */
export function planContinue(core: EngineCore, s: EntryState): string {
  const now = core.now();
  const until = s.facts.rateLimitedUntil;
  const at = until !== null && Date.parse(until) > now.getTime() ? until : now.toISOString();
  s.patch((e) => (e.continueAt === at ? e : { ...e, continueAt: at }));
  s.reduce({ type: 'wakeup', at });
  armContinue(core, s, at);
  core.log.info({ entryId: s.id, continueAt: at }, 'continue after the rate limit scheduled');
  return at;
}

/** Drops a plan (timer, `Entry.continueAt`, `wakeupAt`); no-op without one. */
export function cancelContinue(s: EntryState): void {
  s.continueTimer?.cancel();
  s.continueTimer = null;
  if (s.entry.continueAt !== null) s.patch((e) => ({ ...e, continueAt: null }));
  if (s.facts.wakeupAt !== null) s.reduce({ type: 'wakeup', at: null });
}

/** Server start (ADR-112): future → timer, ≤ grace overdue → at once, older → dropped. */
export function restoreContinue(core: EngineCore, s: EntryState): void {
  const at = s.entry.continueAt;
  if (at === null) return;
  const due = Date.parse(at);
  const now = core.now().getTime();
  if (s.entry.archived || s.entry.external !== null || Number.isNaN(due)) {
    cancelContinue(s);
    return;
  }
  if (due > now) {
    s.reduce({ type: 'wakeup', at });
    armContinue(core, s, at);
    return;
  }
  if (now - due <= core.options.continueGraceMs) {
    core.log.info({ entryId: s.id, continueAt: at }, 'overdue continue sent after the restart');
    armContinue(core, s, at);
    return;
  }
  core.log.info({ entryId: s.id, continueAt: at }, 'continue dropped – overdue beyond the grace period');
  cancelContinue(s);
}

function armContinue(core: EngineCore, s: EntryState, at: string): void {
  s.continueTimer?.cancel();
  s.continueTimer = null;
  if (core.shuttingDown()) return;
  const delay = Math.min(Math.max(0, Date.parse(at) - core.now().getTime()), MAX_TIMER_DELAY_MS);
  s.continueTimer = core.timers.setTimeout(() => {
    s.continueTimer = null;
    void fireContinue(core, s, at);
  }, delay);
}

async function fireContinue(core: EngineCore, s: EntryState, at: string): Promise<void> {
  // Cancelled or replaced meanwhile (every change of the plan goes through Entry.continueAt).
  if (core.shuttingDown() || s.entry.continueAt !== at) return;
  if (Date.parse(at) > core.now().getTime()) {
    armContinue(core, s, at);
    return;
  }
  cancelContinue(s);
  if (s.entry.archived || s.facts.runState === 'external') return;
  s.cancelRetry();
  try {
    await s.lifecycle.run(async () => {
      // Archived or handed off while waiting for the lock: nothing to continue here.
      if (s.entry.archived || s.facts.runState === 'external') return;
      if (s.runtime === null) await startRuntime(s, core, { byClientId: null });
      deliverPrompt(s, core, CONTINUE_PROMPT, 'next');
    });
    core.log.info({ entryId: s.id }, 'scheduled continue sent');
  } catch (error) {
    // A start failure shows as status `error` in the summary (failStart); nothing is retried.
    core.log.warn({ err: error, entryId: s.id }, 'scheduled continue failed');
  }
}
