import { describe, expect, it } from 'vitest';
import { createManualTimers } from '../sessions/lib/timers';
import {
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  POLL_TERMINAL_BYTES,
  POLL_TICK_BYTES,
  createPoller,
  type PollerHooks,
} from './poller';

/** A source that has `waiting` bytes and hands them out in chunks of at most `chunk`. */
interface Source {
  name: string;
  waiting: number;
  chunk: number;
  outputs: number[];
  reads: number;
}

function source(name: string, waiting: number, chunk = 4096): Source {
  return { name, waiting, chunk, outputs: [], reads: 0 };
}

function setup(sources: Source[], extra: Partial<PollerHooks<Source>> = {}) {
  const timers = createManualTimers();
  const order: string[] = [];
  let exitsChecked = 0;
  let ending = false;
  let active = true;
  const hooks: PollerHooks<Source> = {
    beforeTick: () => undefined,
    readable: () => sources,
    read(s, max) {
      s.reads += 1;
      const take = Math.min(s.waiting, s.chunk, max);
      if (take === 0) return null;
      s.waiting -= take;
      return new Uint8Array(take);
    },
    output(s, data) {
      s.outputs.push(data.length);
      order.push(s.name);
    },
    checkExits() {
      exitsChecked += 1;
      return ending;
    },
    active: () => active,
    ...extra,
  };
  const poller = createPoller(hooks, { timers, now: () => timers.elapsed() });
  return {
    timers,
    poller,
    order,
    exitsChecked: () => exitsChecked,
    setEnding: (value: boolean) => {
      ending = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
  };
}

describe('createPoller (WP-99)', () => {
  it('hands all reads of one source in a tick over once, concatenated', () => {
    const a = source('a', 10_000, 1000);
    const { poller } = setup([a]);
    poller.tick();
    expect(a.outputs).toEqual([10_000]);
    expect(a.reads).toBe(11); // ten chunks and the empty read that ends the loop
  });

  it('reads at most POLL_TERMINAL_BYTES per source and tick', () => {
    const a = source('a', POLL_TERMINAL_BYTES * 3);
    const { poller } = setup([a]);
    poller.tick();
    expect(a.outputs).toEqual([POLL_TERMINAL_BYTES]);
    poller.tick();
    expect(a.outputs).toEqual([POLL_TERMINAL_BYTES, POLL_TERMINAL_BYTES]);
  });

  it('reads at most POLL_TICK_BYTES per tick and rotates the start', () => {
    const sources = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => source(name, POLL_TERMINAL_BYTES * 10));
    const { poller, order } = setup(sources);
    poller.tick();
    const total = sources.reduce((sum, s) => sum + s.outputs.reduce((x, y) => x + y, 0), 0);
    expect(total).toBe(POLL_TICK_BYTES);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    order.length = 0;
    poller.tick();
    expect(order).toEqual(['b', 'c', 'd', 'e']);
    order.length = 0;
    poller.tick();
    expect(order).toEqual(['c', 'd', 'e', 'f']);
  });

  it('ticks every 16 ms after data, every 100 ms when idle, and checks exits every tick', () => {
    const a = source('a', 0);
    const { timers, poller, exitsChecked } = setup([a]);
    poller.wake();
    expect(timers.pending().map((t) => t.ms)).toEqual([POLL_ACTIVE_MS]);
    timers.advance(POLL_ACTIVE_MS);
    expect(exitsChecked()).toBe(1);
    // Nothing read → idle cadence.
    expect(timers.pending().map((t) => t.ms)).toEqual([POLL_IDLE_MS]);
    a.waiting = 100;
    timers.advance(POLL_IDLE_MS);
    expect(a.outputs).toEqual([100]);
    expect(timers.pending().map((t) => t.ms)).toEqual([POLL_ACTIVE_MS]);
    expect(exitsChecked()).toBe(2);
  });

  it('wake pulls an idle tick forward and never delays an earlier one', () => {
    const { timers, poller } = setup([source('a', 0)]);
    poller.tick();
    expect(timers.pending()[0]?.dueAt).toBe(POLL_IDLE_MS);
    timers.advance(10);
    poller.wake();
    expect(timers.pending()).toHaveLength(1);
    expect(timers.pending()[0]?.dueAt).toBe(10 + POLL_ACTIVE_MS);
    poller.wake();
    expect(timers.pending()[0]?.dueAt).toBe(10 + POLL_ACTIVE_MS);
  });

  it('keeps ticking fast while a shell is ending', () => {
    const { timers, poller, setEnding } = setup([source('a', 0)]);
    setEnding(true);
    poller.tick();
    expect(timers.pending().map((t) => t.ms)).toEqual([POLL_ACTIVE_MS]);
  });

  it('stops while inactive and starts again on wake', () => {
    const { timers, poller, setActive } = setup([source('a', 0)]);
    setActive(false);
    poller.tick();
    expect(poller.running).toBe(false);
    expect(timers.pending()).toEqual([]);
    setActive(true);
    poller.wake();
    expect(poller.running).toBe(true);
    poller.stop();
    expect(timers.pending()).toEqual([]);
  });

  it('runs beforeTick first and survives a throwing hook', () => {
    const calls: string[] = [];
    const a = source('a', 10);
    const errors: unknown[] = [];
    const timers = createManualTimers();
    const poller = createPoller<Source>(
      {
        beforeTick: () => calls.push('before'),
        readable: () => [a],
        read: () => {
          calls.push('read');
          throw new Error('boom');
        },
        output: () => calls.push('output'),
        checkExits: () => {
          calls.push('exits');
          return false;
        },
        active: () => true,
      },
      { timers, now: () => timers.elapsed(), onError: (error) => errors.push(error) },
    );
    poller.tick();
    expect(calls).toEqual(['before', 'read', 'exits']);
    expect(errors).toHaveLength(1);
    expect(poller.running).toBe(true);
  });
});
