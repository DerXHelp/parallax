import { describe, expect, it, vi } from 'vitest';
import { createManualTimers, realTimers } from './timers';

const realSetImmediate = setImmediate;
const macrotask = () =>
  new Promise<void>((resolve) => {
    realSetImmediate(resolve);
  });

describe('createManualTimers', () => {
  it('delays fire only on advance, in due order; cancel works; zero delays fire on a macrotask', async () => {
    const timers = createManualTimers();
    const fired: string[] = [];
    timers.setTimeout(() => fired.push('b'), 200);
    const cancelled = timers.setTimeout(() => fired.push('x'), 50);
    timers.setTimeout(() => fired.push('a'), 100);
    timers.setTimeout(() => fired.push('zero'), 0);
    cancelled.cancel();
    expect(timers.pending().map((t) => t.ms)).toEqual([100, 200]);
    timers.advance(99);
    expect(fired).toEqual([]);
    await macrotask();
    expect(fired).toEqual(['zero']);
    timers.advance(1);
    expect(fired).toEqual(['zero', 'a']);
    expect(timers.elapsed()).toBe(100);
    // A timer scheduled by a callback within the window fires in the same advance.
    timers.setTimeout(() => {
      fired.push('c');
      timers.setTimeout(() => fired.push('d'), 10);
    }, 50);
    timers.advance(500);
    expect(fired).toEqual(['zero', 'a', 'c', 'd', 'b']);
    expect(timers.runNext()).toBe(false);
    timers.setTimeout(() => fired.push('e'), 1_000);
    expect(timers.runNext()).toBe(true);
    expect(fired.at(-1)).toBe('e');
    expect(timers.elapsed()).toBe(1_600);
  });

  it('a cancelled zero-delay timer never fires', async () => {
    const timers = createManualTimers();
    const callback = vi.fn();
    timers.setTimeout(callback, 0).cancel();
    await macrotask();
    expect(callback).not.toHaveBeenCalled();
  });

  it('realTimers fire and can be cancelled', async () => {
    const callback = vi.fn();
    realTimers.setTimeout(callback, 0);
    const cancelled = vi.fn();
    realTimers.setTimeout(cancelled, 0).cancel();
    // A 0-ms timer always fires before a later one: no wall-clock assumption.
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
