/** Exponential reconnect backoff with jitter (state/connection.ts). */
export interface BackoffOptions {
  /** Delay of the first retry. */
  initialMs: number;
  /** Upper bound of the delay (before jitter). */
  maxMs: number;
  /** Growth per attempt. */
  factor: number;
  /** Relative spread 0…1 around the delay (0.2 = ±20 %). */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 500, maxMs: 15_000, factor: 2, jitter: 0.2 };

/**
 * Delay before retry number `attempt` (0-based): `initialMs · factor^attempt`, capped at `maxMs`,
 * spread by ±`jitter`. `random` returns [0, 1); 0.5 gives the exact base delay (tests).
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.floor(attempt));
  const base = Math.min(options.maxMs, options.initialMs * options.factor ** exponent);
  const spread = base * Math.min(1, Math.max(0, options.jitter));
  return Math.max(0, Math.round(base - spread + random() * 2 * spread));
}
