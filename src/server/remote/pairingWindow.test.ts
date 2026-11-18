import { describe, expect, it, vi } from 'vitest';
import { parsePairingCode } from '@shared/pairing';
import { PAIRING_MAX_FAILURES_TOTAL, PairingWindow, type PairingWindowCloseReason } from './pairingWindow';

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

  it('closes after 3 failed attempts from one address', () => {
    const { window, closed } = setup();
    const opened = window.open();
    expect(window.fail(opened.id, '192.0.2.7')).toBe(false);
    expect(window.fail(opened.id, '192.0.2.7')).toBe(false);
    expect(window.current()?.failures).toBe(2);
    expect(window.fail(opened.id, '192.0.2.7')).toBe(true);
    expect(window.current()).toBeNull();
    expect(closed).toEqual([[opened.id, 'failures']]);
    expect(window.fail(opened.id, '192.0.2.7')).toBe(false);
  });

  it('failures of other addresses do not close it for the right one – until 20 in all', () => {
    const { window, closed } = setup();
    const opened = window.open();
    for (let i = 0; i < 6; i += 1) {
      expect(window.fail(opened.id, `192.0.2.${String(i)}`)).toBe(false);
      expect(window.fail(opened.id, `192.0.2.${String(i)}`)).toBe(false);
    }
    expect(window.fail(opened.id, '198.51.100.1')).toBe(false);
    expect(window.isCurrent(opened.id)).toBe(true);
    for (let i = 13; i < PAIRING_MAX_FAILURES_TOTAL - 1; i += 1) {
      expect(window.fail(opened.id, `203.0.113.${String(i)}`)).toBe(false);
    }
    expect(window.fail(opened.id, '203.0.113.200')).toBe(true);
    expect(closed).toEqual([[opened.id, 'failures']]);
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
