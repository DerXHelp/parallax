import { describe, expect, it, vi } from 'vitest';
import { parsePairingCode } from '@shared/pairing';
import { PairingWindow, type PairingWindowCloseReason } from './pairingWindow';

function setup(windowMs = 600_000) {
  let now = 1_000_000;
  const closed: [string, PairingWindowCloseReason][] = [];
  const window = new PairingWindow({
    now: () => new Date(now),
    windowMs,
    onClose: (id, reason) => closed.push([id, reason]),
  });
  return {
    window,
    closed,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('pairing window (§B.7)', () => {
  it('opens with a 128-bit code in the display format and 10 minutes', () => {
    const { window } = setup();
    const opened = window.open();
    const bytes = parsePairingCode(opened.code);
    expect(bytes).toHaveLength(16);
    expect(opened.expiresAt.getTime()).toBe(1_000_000 + 600_000);
    expect(window.codeFor(opened.id)?.equals(Buffer.from(bytes ?? []))).toBe(true);
    expect(window.isCurrent(opened.id)).toBe(true);
    expect(window.isExpired(opened.id)).toBe(false);
  });

  it('a new window replaces the open one (old id no longer valid, code zeroed)', () => {
    const { window, closed } = setup();
    const first = window.open();
    const code = window.codeFor(first.id);
    const second = window.open();
    expect(closed).toEqual([[first.id, 'replaced']]);
    expect(window.isCurrent(first.id)).toBe(false);
    expect(window.codeFor(first.id)).toBeNull();
    expect(second.code).not.toBe(first.code);
    expect(code).not.toBeNull();
  });

  it('closes after 3 failed attempts', () => {
    const { window, closed } = setup();
    const opened = window.open();
    expect(window.fail(opened.id)).toBe(false);
    expect(window.fail(opened.id)).toBe(false);
    expect(window.current()?.failures).toBe(2);
    expect(window.fail(opened.id)).toBe(true);
    expect(window.current()).toBeNull();
    expect(closed).toEqual([[opened.id, 'failures']]);
    expect(window.fail(opened.id)).toBe(false);
  });

  it('is single use', () => {
    const { window, closed } = setup();
    const opened = window.open();
    expect(window.consume(opened.id)).toBe(true);
    expect(window.consume(opened.id)).toBe(false);
    expect(closed).toEqual([[opened.id, 'used']]);
  });

  it('expires by time (checked) and by its timer (closed)', () => {
    vi.useFakeTimers();
    try {
      const { window, closed, advance } = setup(1_000);
      const opened = window.open();
      advance(1_000);
      expect(window.isExpired(opened.id)).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(closed).toEqual([[opened.id, 'expired']]);
      expect(window.expiresAt()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the code buffer is zeroed on close; copies are independent', () => {
    const { window } = setup();
    const opened = window.open();
    const copy = window.codeFor(opened.id);
    const internal = (window as unknown as { state: { code: Buffer } }).state.code;
    window.close('cancelled');
    expect(internal.every((byte) => byte === 0)).toBe(true);
    expect(copy?.some((byte) => byte !== 0)).toBe(true);
  });
});
