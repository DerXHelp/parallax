import { describe, expect, it } from 'vitest';
import { TERMINAL_LIMITS } from '@shared/terminal';
import { RING_LINE_SEARCH_BYTES, createByteRing } from './ring';

const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');
const text = (data: Uint8Array): string => Buffer.from(data).toString('utf8');

describe('createByteRing (WP-99)', () => {
  it('defaults to the scrollback limit of the contract', () => {
    expect(createByteRing().capacity).toBe(TERMINAL_LIMITS.scrollbackBytes);
    expect(() => createByteRing(0)).toThrow(RangeError);
  });

  it('keeps everything below the capacity, oldest first', () => {
    const ring = createByteRing(100);
    ring.push(bytes('abc'));
    ring.push(bytes(''));
    ring.push(bytes('def'));
    expect(ring.size).toBe(6);
    expect(text(ring.snapshot())).toBe('abcdef');
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.snapshot()).toHaveLength(0);
  });

  it('cuts just after the first line break behind the cut point', () => {
    const ring = createByteRing(10);
    ring.push(bytes('aaaa\nbbbb\n'));
    // 4 bytes too many: the hard cut would start at "\nbbbb…"; the line break right there wins.
    ring.push(bytes('cccc'));
    expect(text(ring.snapshot())).toBe('bbbb\ncccc');
    expect(ring.size).toBe(9);
  });

  it('finds the line break across chunk borders', () => {
    const ring = createByteRing(8);
    ring.push(bytes('12'));
    ring.push(bytes('34'));
    ring.push(bytes('5\n67'));
    ring.push(bytes('89'));
    // excess 2 → search from "34…": the "\n" after "5" is the cut.
    expect(text(ring.snapshot())).toBe('6789');
  });

  it('cuts hard when no line break lies behind the cut point', () => {
    const ring = createByteRing(16);
    ring.push(bytes(`\n${'x'.repeat(5000)}`));
    expect(text(ring.snapshot())).toBe('x'.repeat(16));
  });

  it('looks for the line break only within the search window', () => {
    const capacity = 5000;
    const head = 'a'.repeat(100);
    // Line break at the last byte of the window (cut point 100 + 4095): taken.
    const inside = createByteRing(capacity);
    inside.push(bytes(`${head}${'x'.repeat(RING_LINE_SEARCH_BYTES - 1)}\n${'b'.repeat(904)}`));
    expect(text(inside.snapshot())).toBe('b'.repeat(904));
    // One byte further: outside, so the cut is hard.
    const outside = createByteRing(capacity);
    outside.push(bytes(`${head}${'x'.repeat(RING_LINE_SEARCH_BYTES)}\n${'b'.repeat(903)}`));
    expect(outside.size).toBe(capacity);
    expect(text(outside.snapshot()).startsWith('xxx')).toBe(true);
  });

  it('does not start inside a UTF-8 character after a hard cut', () => {
    const ring = createByteRing(5);
    // "ü" is two bytes; a hard cut at its second byte moves one further.
    ring.push(bytes('aüüü'));
    expect(text(ring.snapshot())).toBe('üü');
    expect(ring.size).toBe(4);
  });

  it('handles a single push larger than the capacity', () => {
    const ring = createByteRing(4);
    ring.push(bytes('0123456789'));
    expect(text(ring.snapshot())).toBe('6789');
  });
});
