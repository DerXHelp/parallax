/**
 * Scrollback of one embedded terminal (WP-99): the last `capacity` bytes of its output, replayed to
 * a socket on `attach`. Chunks are kept as pushed (no copy); trimming drops whole chunks and slices
 * the first one.
 *
 * Trimming prefers a line start: the cut moves to just after the first `\n` behind the hard cut
 * point when one lies within `RING_LINE_SEARCH_BYTES`; otherwise it cuts hard, skipping UTF-8
 * continuation bytes so the replay never starts inside a character. An escape sequence can still
 * be cut – the replay is followed by a resize nudge that makes conhost repaint the screen anyway.
 */
import { TERMINAL_LIMITS } from '@shared/terminal';

/** How far behind the hard cut point a line break is looked for. */
export const RING_LINE_SEARCH_BYTES = 4096;

const NEWLINE = 0x0a;
/** Longest run of UTF-8 continuation bytes after a lead byte. */
const UTF8_CONTINUATION_MAX = 3;

export interface ByteRing {
  /** Bytes kept now (≤ capacity). */
  readonly size: number;
  readonly capacity: number;
  /** Appends output (the ring keeps the reference; the caller must not reuse the buffer). */
  push(data: Uint8Array): void;
  /** Everything kept, oldest first, as one buffer (empty when nothing is kept). */
  snapshot(): Uint8Array;
  clear(): void;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

export function createByteRing(capacity: number = TERMINAL_LIMITS.scrollbackBytes): ByteRing {
  if (!Number.isSafeInteger(capacity) || capacity <= 0)
    throw new RangeError('ring capacity must be positive');
  let chunks: Uint8Array[] = [];
  let size = 0;

  /** The byte at `offset` of the kept data (undefined past the end). */
  const byteAt = (offset: number): number | undefined => {
    let rest = offset;
    for (const chunk of chunks) {
      if (rest < chunk.length) return chunk[rest];
      rest -= chunk.length;
    }
    return undefined;
  };

  /** Offset just after the first `\n` in [from, from + search), or -1. */
  const lineStartAfter = (from: number): number => {
    const end = Math.min(size, from + RING_LINE_SEARCH_BYTES);
    let base = 0;
    for (const chunk of chunks) {
      const chunkEnd = base + chunk.length;
      if (chunkEnd > from && base < end) {
        const start = Math.max(from, base) - base;
        const stop = Math.min(end, chunkEnd) - base;
        const index = chunk.subarray(start, stop).indexOf(NEWLINE);
        if (index >= 0) return base + start + index + 1;
      }
      if (chunkEnd >= end) break;
      base = chunkEnd;
    }
    return -1;
  };

  const dropFront = (count: number): void => {
    let rest = count;
    while (rest > 0) {
      const first = chunks[0];
      if (first === undefined) break;
      if (first.length <= rest) {
        chunks.shift();
        rest -= first.length;
        size -= first.length;
      } else {
        chunks[0] = first.subarray(rest);
        size -= rest;
        rest = 0;
      }
    }
  };

  const trim = (): void => {
    const excess = size - capacity;
    if (excess <= 0) return;
    let cut = lineStartAfter(excess);
    if (cut < 0) {
      cut = excess;
      for (let i = 0; i < UTF8_CONTINUATION_MAX && isContinuation(byteAt(cut)); i += 1) cut += 1;
    }
    dropFront(cut);
  };

  return {
    get size() {
      return size;
    },
    capacity,
    push(data) {
      if (data.length === 0) return;
      chunks.push(data);
      size += data.length;
      trim();
    },
    snapshot() {
      const out = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    },
    clear() {
      chunks = [];
      size = 0;
    },
  };
}
