import type { SessionSummary } from '@shared/model';
import type { DisplayStatusKind } from '@shared/status';
import { orderSessions } from '@web/lib/session-order';
import { sessionTitle } from '@web/lib/session-title';

/**
 * What "Stop server" interrupts (A.10: the confirmation lists the working and waiting sessions,
 * WP-02 §7.5: computed by the client from the summaries). Only sessions with a running process are
 * affected; sleeping, interrupted, failed and externally continued ones stay as they are.
 */
export interface AffectedSession {
  sessionKey: string;
  title: string;
  kind: DisplayStatusKind;
}

export interface ShutdownImpact {
  /** Working, starting or busy in the background, in sidebar order. */
  working: AffectedSession[];
  /** Waiting for a permission, an answer or a plan review (live decisions). */
  waiting: AffectedSession[];
  /** Further running sessions without work (idle, done, rate limited while idle). */
  idle: number;
}

const WORKING: ReadonlySet<DisplayStatusKind> = new Set(['starting', 'working', 'background']);
const WAITING: ReadonlySet<DisplayStatusKind> = new Set(['needs-permission', 'needs-answer', 'needs-review']);

export function shutdownImpact(
  entries: readonly { sessionKey: string; summary: SessionSummary }[],
  now: Date,
): ShutdownImpact {
  const impact: ShutdownImpact = { working: [], waiting: [], idle: 0 };
  // Archived sessions are included: a running process is stopped no matter where it is listed.
  for (const { entry, status } of orderSessions(entries, now, { includeArchived: true })) {
    const affected = { sessionKey: entry.sessionKey, title: sessionTitle(entry.summary), kind: status.kind };
    if (WAITING.has(status.kind)) impact.waiting.push(affected);
    else if (WORKING.has(status.kind)) impact.working.push(affected);
    else if (entry.summary.status.runState === 'idle') impact.idle += 1;
  }
  return impact;
}
