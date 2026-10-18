import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { sampleId } from '@shared/samples';
import { isHandoffPending, resetHandoffs, trackHandoff, useHandoffPending } from './handoff';

const KEY = makeSessionKey(LOCAL_HOST_ID, sampleId('en', 1));
const OTHER = makeSessionKey(LOCAL_HOST_ID, sampleId('en', 2));

afterEach(() => {
  resetHandoffs();
});

describe('handoffs on their way (WP41-07)', () => {
  it('a session counts from the click until the answer – answered or refused, every click', async () => {
    let answer: () => void = () => undefined;
    let refuse: (error: Error) => void = () => undefined;
    const first = trackHandoff(
      KEY,
      new Promise<void>((resolve) => {
        answer = resolve;
      }),
    );
    const second = trackHandoff(
      KEY,
      new Promise<void>((_resolve, reject) => {
        refuse = reject;
      }),
    );
    expect(isHandoffPending(KEY)).toBe(true);
    expect(isHandoffPending(OTHER)).toBe(false);
    answer();
    await first;
    // The second click is still on its way.
    expect(isHandoffPending(KEY)).toBe(true);
    refuse(new Error('refused'));
    await expect(second).rejects.toThrow('refused');
    expect(isHandoffPending(KEY)).toBe(false);
  });

  it('useHandoffPending follows the state', async () => {
    const { result } = renderHook(() => useHandoffPending(KEY));
    expect(result.current).toBe(false);
    let answer: () => void = () => undefined;
    let request: Promise<void> = Promise.resolve();
    act(() => {
      request = trackHandoff(
        KEY,
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
      );
    });
    expect(result.current).toBe(true);
    await act(async () => {
      answer();
      await request;
    });
    expect(result.current).toBe(false);
  });
});
