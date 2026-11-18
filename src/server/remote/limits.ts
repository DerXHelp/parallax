/**
 * Limits of the remote-access listener (docs/wp/WP-76.md §B.6, §B.7, §B.10) and the small rate
 * limiters behind them. All counters are bounded in memory (an attacker cycling addresses cannot
 * grow them without bound).
 */
import { REMOTE_PAIR_BODY_MAX_BYTES } from '@shared/http';
import { HANDSHAKE_TIMEOUT_MS } from '../secure/tlsProfile';

export interface RemoteLimits {
  /** Raw TCP connections in total (`net.Server.maxConnections`). */
  maxConnections: number;
  /** Concurrent raw connections per address (before TLS). */
  perAddressConcurrent: number;
  /** New connections per address and minute (token bucket refill) … */
  perAddressPerMinute: number;
  /** … with this burst. */
  perAddressBurst: number;
  handshakeTimeoutMs: number;
  /** Concurrent sockets of the coupled computer (windows + relay + HTTP). */
  peerSockets: number;
  proofTimeoutMs: number;
  /** Concurrent sockets of an open pairing window. */
  pairingSockets: number;
  pairingPerAddressPerMinute: number;
  pairingTotalPerMinute: number;
  pairingIdleMs: number;
  pairingBodyBytes: number;
  pairingHeaderBytes: number;
  /** Pins of the last revoked couplings kept for `revoked_key` (peer.json). */
  revokedPins: number;
}

export const REMOTE_LIMITS: RemoteLimits = {
  maxConnections: 64,
  perAddressConcurrent: 4,
  perAddressPerMinute: 10,
  perAddressBurst: 5,
  handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
  peerSockets: 16,
  proofTimeoutMs: 10_000,
  pairingSockets: 4,
  pairingPerAddressPerMinute: 5,
  pairingTotalPerMinute: 20,
  pairingIdleMs: 15_000,
  pairingBodyBytes: REMOTE_PAIR_BODY_MAX_BYTES,
  pairingHeaderBytes: 4096,
  revokedPins: 8,
};

/** Keys tracked at most (beyond that the fullest/oldest entries are dropped). */
const MAX_KEYS = 4096;
const MINUTE_MS = 60_000;

/** Token bucket per key: `burst` tokens, refilled with `perMinute` per minute. */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly burst: number,
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token; false = over the limit. */
  take(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    const refill = ((now - bucket.at) * this.perMinute) / MINUTE_MS;
    const tokens = Math.min(this.burst, bucket.tokens + refill);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return false;
    }
    this.buckets.delete(key);
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    this.prune(now);
    return true;
  }

  private prune(now: number): void {
    if (this.buckets.size <= MAX_KEYS) return;
    for (const [key, bucket] of this.buckets) {
      // Full again → forgetting it changes nothing.
      if (bucket.tokens + ((now - bucket.at) * this.perMinute) / MINUTE_MS >= this.burst)
        this.buckets.delete(key);
      if (this.buckets.size <= MAX_KEYS) return;
    }
    // Still too many: drop the oldest (insertion order = last use).
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key);
      if (this.buckets.size <= MAX_KEYS) return;
    }
  }
}

/** At most `limit` hits per key within a sliding minute. */
export class MinuteWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts a hit; false = the limit was already reached (the hit is not counted). */
  hit(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < MINUTE_MS);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > MAX_KEYS) {
      const oldest = this.hits.keys().next();
      if (oldest.done !== true) this.hits.delete(oldest.value);
    }
    return true;
  }
}

/** Concurrent things per key (raw sockets per address). */
export class Concurrency {
  private readonly counts = new Map<string, number>();

  /** Adds one unless `limit` is reached. */
  acquire(key: string, limit: number): boolean {
    const count = this.counts.get(key) ?? 0;
    if (count >= limit) return false;
    this.counts.set(key, count + 1);
    return true;
  }

  release(key: string): void {
    const count = (this.counts.get(key) ?? 0) - 1;
    if (count <= 0) this.counts.delete(key);
    else this.counts.set(key, count);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}
