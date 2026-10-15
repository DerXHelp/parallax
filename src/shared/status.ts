/**
 * Status model (A.4, A.5, C.5, F.10, F.11): the server keeps *facts* (`StatusFacts`), server
 * (notifications) and UI derive the display with the same pure functions.
 * Design and decision tables: docs/wp/WP-02.md §6.
 */
import { z } from 'zod';
import { decisionKindSchema, isoDateTimeSchema, type DecisionKind } from './common';
import { errorCodeSchema } from './errors';

/**
 * A.4 runState. "waiting(permission|question|plan)" is NOT stored but derived from open
 * decisions: decisions may be open while running (background subagent) or after a `result`.
 */
export const RUN_STATES = [
  'starting',
  'working',
  'idle',
  'sleeping',
  'error',
  'interrupted',
  'external',
] as const;
export const runStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof runStateSchema>;

export const TURN_OUTCOMES = ['success', 'error', 'interrupted'] as const;
export const turnOutcomeSchema = z.enum(TURN_OUTCOMES);
export type TurnOutcome = z.infer<typeof turnOutcomeSchema>;

/** Last finished turn (also re-exported from model.ts). */
export const turnInfoSchema = z.object({
  outcome: turnOutcomeSchema,
  endedAt: isoDateTimeSchema,
  durationMs: z.number().nonnegative(),
});
export type TurnInfo = z.infer<typeof turnInfoSchema>;

export const decisionCountsSchema = z.object({
  permission: z.number().int().nonnegative(),
  question: z.number().int().nonnegative(),
  plan: z.number().int().nonnegative(),
  /** Kind of the oldest open decision (A.6: the bar shows the oldest one). */
  oldestKind: decisionKindSchema.nullable(),
  /** A.10: read-only cards after a server restart. */
  expired: z.number().int().nonnegative(),
});
export type DecisionCounts = z.infer<typeof decisionCountsSchema>;

export const statusFactsSchema = z.object({
  runState: runStateSchema,
  /** Open (not expired) decisions per kind and the kind of the oldest one. */
  decisions: decisionCountsSchema,
  unread: z.boolean(),
  /** Non-ambient background tasks (background_tasks_changed). */
  backgroundTasks: z.number().int().nonnegative(),
  queuedPrompts: z.number().int().nonnegative(),
  /** Only for rate limit status 'rejected'. */
  rateLimitedUntil: isoDateTimeSchema.nullable(),
  /** system/status 'compacting'. */
  compacting: z.boolean(),
  /** Active api_retry series. */
  retrying: z.boolean(),
  /** Scheduled wakeup (A.5); Phase 1 always null. */
  wakeupAt: isoDateTimeSchema.nullable(),
  lastTurn: turnInfoSchema.nullable(),
  /** Set exactly when runState is 'error'. */
  errorCode: errorCodeSchema.nullable(),
});
export type StatusFacts = z.infer<typeof statusFactsSchema>;

export const INITIAL_STATUS_FACTS: StatusFacts = Object.freeze({
  runState: 'sleeping',
  decisions: Object.freeze({ permission: 0, question: 0, plan: 0, oldestKind: null, expired: 0 }),
  unread: false,
  backgroundTasks: 0,
  queuedPrompts: 0,
  rateLimitedUntil: null,
  compacting: false,
  retrying: false,
  wakeupAt: null,
  lastTurn: null,
  errorCode: null,
});

// ---- Display (§6.2) ----

export const DISPLAY_STATUS_KINDS = [
  'needs-permission',
  'needs-answer',
  'needs-review',
  'error',
  'interrupted',
  'rate-limited',
  'starting',
  'working',
  'background',
  'done',
  'idle',
  'sleeping',
  'external',
] as const;
export type DisplayStatusKind = (typeof DISPLAY_STATUS_KINDS)[number];

export type SortBucket = 0 | 1 | 2 | 3 | 4;

export interface DisplayStatusBadges {
  background: boolean;
  compacting: boolean;
  retrying: boolean;
  queued: number;
  expiredDecisions: number;
}

export interface DisplayStatus {
  kind: DisplayStatusKind;
  /** Counts for "Wartet auf dich (n)", Ctrl+K order, window title. Only for needs-*. */
  needsAttention: boolean;
  unread: boolean;
  /** Secondary badges (icon + text, never color only – B Barrierearmut). */
  badges: DisplayStatusBadges;
  /** Only while in the future. */
  rateLimitedUntil: string | null;
  /** Sidebar sort bucket: 0 attention, 1 error/interrupted/rate-limited, 2 working/starting/background, 3 done, 4 rest. */
  sortBucket: SortBucket;
}

const NEEDS_KIND: Readonly<Record<DecisionKind, DisplayStatusKind>> = {
  permission: 'needs-permission',
  question: 'needs-answer',
  plan: 'needs-review',
};

/** Open (not expired) decisions. */
export function openDecisionCount(facts: StatusFacts): number {
  const d = facts.decisions;
  return d.permission + d.question + d.plan;
}

function isFuture(iso: string | null, now: Date): boolean {
  return iso !== null && Date.parse(iso) > now.getTime();
}

/** oldestKind, or (inconsistent facts) the first kind with an open decision. */
function attentionKind(facts: StatusFacts): DecisionKind {
  const d = facts.decisions;
  if (d.oldestKind !== null) return d.oldestKind;
  if (d.permission > 0) return 'permission';
  if (d.question > 0) return 'question';
  return 'plan';
}

function classify(facts: StatusFacts, now: Date): { kind: DisplayStatusKind; sortBucket: SortBucket } {
  const { runState } = facts;
  // Row 1
  if (runState === 'external') return { kind: 'external', sortBucket: 4 };
  // Row 2: decisions only exist while a process runs; the runState guard covers inconsistencies.
  if (
    openDecisionCount(facts) > 0 &&
    runState !== 'sleeping' &&
    runState !== 'interrupted' &&
    runState !== 'error'
  ) {
    return { kind: NEEDS_KIND[attentionKind(facts)], sortBucket: 0 };
  }
  // Rows 3–5
  if (runState === 'error') return { kind: 'error', sortBucket: 1 };
  if (runState === 'interrupted') return { kind: 'interrupted', sortBucket: 1 };
  if (isFuture(facts.rateLimitedUntil, now) && (runState === 'idle' || runState === 'sleeping')) {
    return { kind: 'rate-limited', sortBucket: 1 };
  }
  // Rows 6–11
  if (runState === 'starting') return { kind: 'starting', sortBucket: 2 };
  if (runState === 'working') return { kind: 'working', sortBucket: 2 };
  if (runState === 'idle') {
    if (facts.backgroundTasks > 0 || facts.queuedPrompts > 0 || isFuture(facts.wakeupAt, now)) {
      return { kind: 'background', sortBucket: 2 };
    }
    if (facts.unread) return { kind: 'done', sortBucket: 3 };
    return { kind: 'idle', sortBucket: 4 };
  }
  // runState === 'sleeping'
  return { kind: 'sleeping', sortBucket: facts.unread ? 3 : 4 };
}

/** The one display-status derivation for server and UI (A.4). First matching row of §6.2 wins. */
export function deriveDisplayStatus(facts: StatusFacts, now: Date): DisplayStatus {
  const { kind, sortBucket } = classify(facts, now);
  return {
    kind,
    needsAttention: kind === 'needs-permission' || kind === 'needs-answer' || kind === 'needs-review',
    unread: facts.unread,
    badges: {
      background: facts.backgroundTasks > 0,
      compacting: facts.compacting,
      retrying: facts.retrying,
      queued: facts.queuedPrompts,
      expiredDecisions: facts.decisions.expired,
    },
    rateLimitedUntil: isFuture(facts.rateLimitedUntil, now) ? facts.rateLimitedUntil : null,
    sortBucket,
  };
}

// ---- Further pure functions (§6.3) ----

/**
 * A.5 + Plan "Ressourcen": may an idle session be put to sleep now? Never with running work,
 * open or expired decisions, background tasks, queued prompts, a pending wakeup, compacting,
 * retrying or a handoff (runState 'external').
 */
export function canSleep(facts: StatusFacts, now: Date): boolean {
  return (
    facts.runState === 'idle' &&
    openDecisionCount(facts) === 0 &&
    facts.decisions.expired === 0 &&
    facts.backgroundTasks === 0 &&
    facts.queuedPrompts === 0 &&
    !isFuture(facts.wakeupAt, now) &&
    !facts.compacting &&
    !facts.retrying
  );
}

export const NOTIFICATION_KINDS = ['permission', 'question', 'plan', 'done', 'error', 'rate_limit'] as const;
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/** B: "Fertig"-Toasts only for turns longer than this (Phase 2: setting). */
export const DONE_NOTIFY_MIN_TURN_MS = 20_000;

const NEEDS_NOTIFICATION: Partial<Record<DisplayStatusKind, NotificationKind>> = {
  'needs-permission': 'permission',
  'needs-answer': 'question',
  'needs-review': 'plan',
};

/**
 * Which notification (if any) a status transition triggers (A.9: the server decides the channel,
 * this decides the event). Pure; the server additionally applies presence rules and calls it with
 * `minDoneTurnMs: 0` for unfocused clients (B "Fertig-Toasts … oder ohne Fokus").
 */
export function notificationFor(
  prev: StatusFacts,
  next: StatusFacts,
  now: Date,
  ctx: { minDoneTurnMs: number },
): NotificationKind | null {
  const p = deriveDisplayStatus(prev, now).kind;
  const n = deriveDisplayStatus(next, now).kind;
  const needs = NEEDS_NOTIFICATION[n];
  if (needs !== undefined) {
    return p !== n || openDecisionCount(next) > openDecisionCount(prev) ? needs : null;
  }
  switch (n) {
    case 'done':
      return (p === 'working' || p === 'background' || p === 'starting') &&
        next.lastTurn !== null &&
        next.lastTurn.durationMs >= ctx.minDoneTurnMs
        ? 'done'
        : null;
    case 'error':
      return p === 'error' ? null : 'error';
    case 'rate-limited':
      return p === 'rate-limited' ? null : 'rate_limit';
    default:
      return null;
  }
}
