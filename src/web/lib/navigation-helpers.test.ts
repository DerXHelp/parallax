import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleConversation, sampleId, sampleRateLimitInfo, sampleTime } from '@shared/samples';
import { limitBars } from './account-limits';
import { copyText } from './clipboard';
import { earlierConversations } from './conversations';
import { shortModelName } from './model-name';
import { STORAGE_KEYS } from './storage';
import { openSessionWindow, sessionWindowUrl } from './windows';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shortModelName', () => {
  it.each([
    [null, null],
    ['', null],
    ['   ', null],
    ['claude-opus-5-5', 'opus'],
    ['opus', 'opus'],
    ['opus[1m]', 'opus'],
    ['claude-sonnet-4-6-20260101', 'sonnet'],
    ['us.anthropic.claude-sonnet-5-5-v1:0', 'sonnet'],
    ['Claude-Haiku-5-5', 'haiku'],
    ['claude-fable-1', 'fable'],
    ['internal-coder-xl', 'internal-coder-xl'],
    [' gpt-like-custom ', 'gpt-like-custom'],
  ])('%j → %j', (model, expected) => {
    expect(shortModelName(model)).toBe(expected);
  });
});

describe('openSessionWindow (ADR-116)', () => {
  it('opens /#session=<entryId> as a popup without opener', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const entryId = sampleId('en', 7);
    openSessionWindow(entryId);
    expect(open).toHaveBeenCalledWith(
      `${window.location.origin}/#session=${entryId}`,
      '_blank',
      'popup,noopener',
    );
    expect(sessionWindowUrl('http://127.0.0.1:4711', entryId)).toBe(
      `http://127.0.0.1:4711/#session=${entryId}`,
    );
  });
});

describe('limitBars', () => {
  it('shows the 5-hour and the weekly window from unifiedWindows (fraction → percent)', () => {
    const bars = limitBars(
      sampleRateLimitInfo({
        windows: {
          seven_day: { utilization: 0.35, resetsAt: sampleTime(7200) },
          five_hour: { utilization: 0.01, resetsAt: sampleTime(3600) },
          extra_window: { utilization: 0.9, resetsAt: null },
        },
      }),
    );
    expect(bars).toEqual([
      { window: 'five_hour', percent: 1, resetsAt: sampleTime(3600) },
      { window: 'seven_day', percent: 35, resetsAt: sampleTime(7200) },
    ]);
  });

  it('falls back to the event window, clamps, and shows nothing without a value', () => {
    expect(
      limitBars(
        sampleRateLimitInfo({ windows: {}, rateLimitType: 'seven_day', utilization: 1.4, resetsAt: null }),
      ),
    ).toEqual([{ window: 'seven_day', percent: 100, resetsAt: null }]);
    expect(
      limitBars(
        sampleRateLimitInfo({
          windows: { five_hour: { utilization: null, resetsAt: null } },
          utilization: null,
        }),
      ),
    ).toEqual([]);
  });
});

describe('earlierConversations (ADR-107)', () => {
  it('drops the current conversation and sorts by start, newest first', () => {
    const current = sampleConversation({ id: sampleId('cv', 3), startedAt: sampleTime(300) });
    const old = sampleConversation({ id: sampleId('cv', 1), startedAt: sampleTime(100) });
    const newer = sampleConversation({ id: sampleId('cv', 2), startedAt: sampleTime(200) });
    expect(earlierConversations([newer, old, current], current.id).map((c) => c.id)).toEqual([
      newer.id,
      old.id,
    ]);
  });
});

describe('copyText', () => {
  it('resolves true on success and false when the clipboard refuses', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await expect(copyText('x')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('x');
    writeText.mockRejectedValueOnce(new Error('denied'));
    await expect(copyText('y')).resolves.toBe(false);
  });
});

describe('storage keys', () => {
  it('keeps the sidebar mode under parallax.sidebar.mode', () => {
    expect(STORAGE_KEYS.sidebarMode).toBe('parallax.sidebar.mode');
  });
});
