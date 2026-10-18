import type { StatusFacts } from '@shared/status';

/**
 * State of the rate-limit banner above the composer field (ADR-112, WP-37 §6), from the status
 * facts and the clock:
 * - `limited`: `rateLimitedUntil` lies ahead, nothing planned → "reset at HH:MM" + "Continue at HH:MM";
 * - `scheduled`: a planned "continue" (`wakeupAt` ahead) → "Continue planned at HH:MM" + "Cancel";
 * - `expired`: the limit has passed, nothing planned and no turn since → "Continue" (right away).
 * The facts keep `rateLimitedUntil` until the next rate-limit event of the CLI, so `expired` ends
 * with the first turn after the reset (or while one runs).
 */
export type RateLimitBannerState =
  | { kind: 'limited'; until: string }
  | { kind: 'scheduled'; at: string; until: string }
  | { kind: 'expired'; until: string };

function epoch(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function rateLimitBannerState(
  facts: Pick<StatusFacts, 'rateLimitedUntil' | 'wakeupAt' | 'runState' | 'lastTurn'>,
  now: number,
): RateLimitBannerState | null {
  const until = facts.rateLimitedUntil;
  const untilMs = epoch(until);
  if (until === null || untilMs === null) return null;
  const wakeupMs = epoch(facts.wakeupAt);
  if (facts.wakeupAt !== null && wakeupMs !== null && wakeupMs > now) {
    return { kind: 'scheduled', at: facts.wakeupAt, until };
  }
  if (untilMs > now) return { kind: 'limited', until };
  if (facts.runState === 'working' || facts.runState === 'starting' || facts.runState === 'external') {
    return null;
  }
  const lastTurnMs = epoch(facts.lastTurn?.endedAt ?? null);
  if (lastTurnMs !== null && lastTurnMs > untilMs) return null;
  return { kind: 'expired', until };
}
