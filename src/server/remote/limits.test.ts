import { describe, expect, it } from 'vitest';
import { Concurrency, MinuteWindow, REMOTE_LIMITS, TokenBuckets } from './limits';

describe('limits of the listener (§B.10)', () => {
  it('has the values of the specification', () => {
    expect(REMOTE_LIMITS).toMatchObject({
      maxConnections: 64,
      perAddressConcurrent: 4,
      perAddressPerMinute: 10,
      perAddressBurst: 5,
      handshakeTimeoutMs: 10_000,
      peerSockets: 16,
      proofTimeoutMs: 10_000,
      pairingSockets: 4,
      pairingPerAddressPerMinute: 5,
      pairingTotalPerMinute: 20,
      pairingIdleMs: 15_000,
      pairingSocketMs: 30_000,
      peerFirstRequestMs: 30_000,
      pairingBodyBytes: 4096,
      revokedPins: 8,
    });
  });

  it('token bucket: burst 5, then 10 per minute', () => {
    let now = 0;
    const buckets = new TokenBuckets(5, 10, () => now);
    for (let i = 0; i < 5; i += 1) expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
    expect(buckets.take('b')).toBe(true);
    now += 6_000; // one token per 6 s
    expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
    now += 600_000;
    for (let i = 0; i < 5; i += 1) expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
  });

  it('token bucket memory stays bounded with many addresses', () => {
    const buckets = new TokenBuckets(5, 10, () => 0);
    for (let i = 0; i < 10_000; i += 1) buckets.take(`10.0.${String(i >> 8)}.${String(i & 255)}`);
    expect((buckets as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(4096);
  });

  it('minute window: at most n hits within a sliding minute', () => {
    let now = 0;
    const window = new MinuteWindow(2, () => now);
    expect(window.hit('x')).toBe(true);
    now += 1_000;
    expect(window.hit('x')).toBe(true);
    expect(window.hit('x')).toBe(false);
    now += 59_500;
    expect(window.hit('x')).toBe(true);
    expect(window.hit('x')).toBe(false);
  });

  it('concurrency per key', () => {
    const concurrency = new Concurrency();
    expect(concurrency.acquire('a', 2)).toBe(true);
    expect(concurrency.acquire('a', 2)).toBe(true);
    expect(concurrency.acquire('a', 2)).toBe(false);
    concurrency.release('a');
    expect(concurrency.count('a')).toBe(1);
    expect(concurrency.acquire('a', 2)).toBe(true);
    concurrency.release('a');
    concurrency.release('a');
    concurrency.release('a');
    expect(concurrency.count('a')).toBe(0);
  });
});
