import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextMacrotask, realSetImmediate, settleWithin, sleep, toError } from './async';

afterEach(() => {
  vi.useRealTimers();
});

describe('lib/async (R2-10)', () => {
  it('toError keeps errors and wraps everything else', () => {
    const error = new TypeError('boom');
    expect(toError(error)).toBe(error);
    expect(toError('text')).toMatchObject({ message: 'text' });
    expect(toError(42)).toBeInstanceOf(Error);
    expect(toError(undefined).message).toBe('undefined');
  });

  it('realSetImmediate/nextMacrotask keep working under fake timers', async () => {
    vi.useFakeTimers();
    expect(realSetImmediate).not.toBe(setImmediate);
    let ran = false;
    realSetImmediate(() => {
      ran = true;
    });
    await nextMacrotask();
    expect(ran).toBe(true);
  });

  it('settleWithin never rejects: done, failed (with the error), timeout (R3-10)', async () => {
    expect(await settleWithin(() => 1, 1_000)).toEqual({ outcome: 'done' });
    expect(await settleWithin(() => Promise.resolve(), 1_000)).toEqual({ outcome: 'done' });
    const error = new Error('boom');
    expect(
      await settleWithin(() => {
        throw error;
      }, 1_000),
    ).toEqual({ outcome: 'failed', error });
    expect(await settleWithin(() => Promise.reject(error), 1_000)).toEqual({ outcome: 'failed', error });
    vi.useFakeTimers();
    const pending = settleWithin(() => new Promise(() => undefined), 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ outcome: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sleep follows the (fake) clock', async () => {
    vi.useFakeTimers();
    let done = false;
    void sleep(100).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
});
