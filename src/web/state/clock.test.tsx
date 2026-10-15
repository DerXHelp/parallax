import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshClock, useNow, useNowUntil } from './clock';

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-15T08:00:00.000Z') });
  refreshClock();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useNowUntil (R1W-10)', () => {
  it('re-renders at its deadline only, not on the ticks of other clock users', () => {
    const deadline = Date.parse('2026-10-15T08:00:05.000Z');
    let untilRenders = 0;
    let seen = 0;
    function Until() {
      seen = useNowUntil([deadline]);
      untilRenders++;
      return null;
    }
    function Ticker() {
      useNow(1000);
      return null;
    }
    render(
      <>
        <Until />
        <Ticker />
      </>,
    );
    const initial = untilRenders;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(untilRenders).toBe(initial);
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(untilRenders).toBe(initial + 1);
    expect(seen).toBeGreaterThanOrEqual(deadline);
  });
});
