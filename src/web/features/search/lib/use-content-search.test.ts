import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, type HostId } from '@shared/common';
import { sampleSearchHit } from '@shared/samples';
import type * as HostsModule from '@web/state/hosts';
import { useContentSearch, type SearchQuery } from './use-content-search';

/**
 * CR7 (code review WP-117): the query depends on the computers' ids, not on the identity of the
 * `hosts` array – a HostState change (new array, same ids) must not send the query again (on the
 * server a newer query of the window supersedes the running one).
 */

const send = vi.hoisted(() => vi.fn());

vi.mock('@web/state/hosts', async (original) => ({
  ...(await original<typeof HostsModule>()),
  sendHostCommand: send,
}));

const QUERY: SearchQuery = { text: 'login', includeArchived: true, includeToolOutput: false };

beforeEach(() => {
  vi.useFakeTimers();
  send.mockReset();
  send.mockImplementation(() => Promise.resolve({ hits: [sampleSearchHit()], truncated: false }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useContentSearch (WP-115, CR7)', () => {
  it('a new hosts array with the same ids keeps the running query', async () => {
    const { result, rerender } = renderHook(
      ({ hosts }: { hosts: readonly HostId[] }) => useContentSearch(QUERY, hosts, 10),
      { initialProps: { hosts: [LOCAL_HOST_ID] as readonly HostId[] } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('done');
    // A HostState change: a new array, the same computer.
    rerender({ hosts: [LOCAL_HOST_ID] });
    rerender({ hosts: [LOCAL_HOST_ID] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('done');
    expect(result.current.hits).toHaveLength(1);
  });

  it('another computer (another id) starts a new query', async () => {
    const { rerender } = renderHook(
      ({ hosts }: { hosts: readonly HostId[] }) => useContentSearch(QUERY, hosts, 10),
      { initialProps: { hosts: [LOCAL_HOST_ID] as readonly HostId[] } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    rerender({ hosts: [LOCAL_HOST_ID, 'pc-2'] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(send.mock.calls.map((call: unknown[]) => call[0])).toEqual([LOCAL_HOST_ID, LOCAL_HOST_ID, 'pc-2']);
  });
});
