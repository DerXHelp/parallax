import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { FileStatResult } from '@shared/model';
import { SAMPLE_IDS, sampleFileInfo, sampleId } from '@shared/samples';
import { STAT_BATCH_MS, STAT_RETRY_MS, STAT_TTL_MS, StatCache, type StatSender } from './stat-cache';

const KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
const OTHER = makeSessionKey(LOCAL_HOST_ID, sampleId('en', 2));

function ok(path: string): FileStatResult {
  return { path, ok: true, file: sampleFileInfo({ path, realPath: path }) };
}

function setup(options: { maxEntries?: number; fail?: boolean } = {}) {
  let now = 1_000_000;
  const calls: { sessionKey: string; paths: readonly string[] }[] = [];
  const send = vi.fn<StatSender>((sessionKey, paths) => {
    calls.push({ sessionKey, paths });
    return options.fail === true ? Promise.reject(new Error('offline')) : Promise.resolve(paths.map(ok));
  });
  const cache = new StatCache({ send, now: () => now, maxEntries: options.maxEntries });
  return {
    cache,
    calls,
    send,
    advance: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StatCache (WP-54 C.10)', () => {
  it('collects requests for 50 ms and sends one file.statMany per session', async () => {
    const { cache, calls, advance } = setup();
    cache.ensure(KEY, 'D:\\work\\a.md');
    cache.ensure(KEY, 'D:\\work\\b.md');
    cache.ensure(KEY, 'd:\\WORK\\a.md'); // same file, other spelling
    cache.ensure(OTHER, 'D:\\work\\c.md');
    expect(cache.peek(KEY, 'D:\\work\\a.md')).toMatchObject({ loading: true, result: null });
    advance(STAT_BATCH_MS - 1);
    expect(calls).toEqual([]);
    advance(1);
    await vi.runAllTimersAsync();
    expect(calls).toEqual([
      { sessionKey: KEY, paths: ['D:\\work\\a.md', 'D:\\work\\b.md'] },
      { sessionKey: OTHER, paths: ['D:\\work\\c.md'] },
    ]);
    expect(cache.peek(KEY, 'D:\\work\\A.MD')).toMatchObject({ loading: false, result: { ok: true } });
  });

  it('splits a batch into commands of at most fileStatBatchMax paths', async () => {
    const { cache, calls } = setup();
    const count = LIMITS.fileStatBatchMax * 2 + 5;
    for (let index = 0; index < count; index++) cache.ensure(KEY, `D:\\work\\f${String(index)}.md`);
    cache.flush();
    await vi.runAllTimersAsync();
    expect(calls.map((call) => call.paths.length)).toEqual([
      LIMITS.fileStatBatchMax,
      LIMITS.fileStatBatchMax,
      5,
    ]);
  });

  it('never sends paths that fail the C.10 filter or a malformed session key', async () => {
    const { cache, send } = setup();
    cache.ensure(KEY, '\\\\server\\share\\a.md');
    cache.ensure(KEY, '\\\\?\\C:\\a.md');
    cache.ensure(KEY, 'C:\\a.md:stream');
    cache.ensure(KEY, 'relative\\a.md');
    cache.ensure('no-key', 'D:\\work\\a.md');
    cache.flush();
    await vi.runAllTimersAsync();
    expect(send).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });

  it('keeps answers for 30 s, then asks again', async () => {
    const { cache, calls, advance } = setup();
    cache.ensure(KEY, 'D:\\work\\a.md');
    cache.flush();
    await vi.runAllTimersAsync();
    advance(STAT_TTL_MS - 1);
    cache.ensure(KEY, 'D:\\work\\a.md');
    cache.flush();
    expect(calls).toHaveLength(1);
    advance(1);
    cache.ensure(KEY, 'D:\\work\\a.md');
    // The old answer stays visible while the new one is under way.
    expect(cache.peek(KEY, 'D:\\work\\a.md')).toMatchObject({ loading: true, result: { ok: true } });
    cache.flush();
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(2);
  });

  it('invalidateBefore drops an answer older than a finished write (and only that)', async () => {
    const { cache, calls, advance } = setup();
    cache.ensure(KEY, 'D:\\work\\a.md');
    cache.flush();
    await vi.runAllTimersAsync();
    const answeredAt = cache.peek(KEY, 'D:\\work\\a.md')?.at ?? 0;
    cache.invalidateBefore(KEY, 'D:\\work\\a.md', answeredAt - 10);
    cache.ensure(KEY, 'D:\\work\\a.md');
    cache.flush();
    expect(calls).toHaveLength(1);
    advance(5);
    cache.invalidateBefore(KEY, 'd:\\work\\a.md', answeredAt + 5);
    expect(cache.peek(KEY, 'D:\\work\\a.md')?.at).toBe(0);
    cache.ensure(KEY, 'D:\\work\\a.md');
    cache.flush();
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(2);
  });

  it('evicts the least recently used entries beyond maxEntries', async () => {
    const { cache } = setup({ maxEntries: 3 });
    for (const name of ['a', 'b', 'c']) cache.ensure(KEY, `D:\\work\\${name}.md`);
    cache.flush();
    await vi.runAllTimersAsync();
    cache.ensure(KEY, 'D:\\work\\a.md'); // fresh: a no-op that touches the entry
    cache.ensure(KEY, 'D:\\work\\d.md');
    cache.flush();
    await vi.runAllTimersAsync();
    expect(cache.size).toBe(3);
    expect(cache.peek(KEY, 'D:\\work\\b.md')).toBeUndefined();
    expect(cache.peek(KEY, 'D:\\work\\a.md')).toBeDefined();
  });

  it('a failed command keeps the entry without result and retries after STAT_RETRY_MS', async () => {
    const { cache, calls, advance } = setup({ fail: true });
    cache.ensure(KEY, 'D:\\work\\a.md');
    cache.flush();
    await vi.runAllTimersAsync();
    expect(cache.peek(KEY, 'D:\\work\\a.md')).toMatchObject({ loading: false, result: null });
    cache.ensure(KEY, 'D:\\work\\a.md');
    cache.flush();
    expect(calls).toHaveLength(1);
    advance(STAT_RETRY_MS);
    cache.ensure(KEY, 'D:\\work\\a.md');
    cache.flush();
    expect(calls).toHaveLength(2);
  });

  it('stores refusals like answers (ok: false)', async () => {
    const send = vi.fn<StatSender>((_, paths) =>
      Promise.resolve(
        paths.map((path) => ({ path, ok: false as const, error: makeError('PATH_NOT_ALLOWED') })),
      ),
    );
    const cache = new StatCache({ send });
    cache.ensure(KEY, 'D:\\private\\a.md');
    cache.flush();
    await vi.runAllTimersAsync();
    expect(cache.peek(KEY, 'D:\\private\\a.md')?.result).toMatchObject({
      ok: false,
      error: { code: 'PATH_NOT_ALLOWED' },
    });
  });

  it('notifies subscribers on every change', async () => {
    const { cache } = setup();
    const listener = vi.fn();
    const unsubscribe = cache.subscribe(listener);
    cache.ensure(KEY, 'D:\\work\\a.md');
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    cache.flush();
    await vi.runAllTimersAsync();
    expect(listener).toHaveBeenCalledTimes(2);
    cache.invalidate(KEY, 'D:\\work\\a.md');
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    cache.clear();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('bundles the notifications of many ensure calls in one tick into one (R5W-10)', async () => {
    const { cache } = setup();
    const listener = vi.fn();
    cache.subscribe(listener);
    // Like 50 links mounting in one render: each effect calls ensure.
    for (let index = 0; index < 50; index++) cache.ensure(KEY, `D:\\work\\f${String(index)}.md`);
    expect(listener).not.toHaveBeenCalled();
    // The snapshot is current before the notification.
    expect(cache.peek(KEY, 'D:\\work\\f49.md')).toMatchObject({ loading: true });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    cache.flush();
    await vi.runAllTimersAsync();
    // One answer (one batch) → one more notification.
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
