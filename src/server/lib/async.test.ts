import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextMacrotask, realSetImmediate, sleep, toError } from './async';

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
