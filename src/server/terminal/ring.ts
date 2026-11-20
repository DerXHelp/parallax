/**
 * Scrollback of one embedded terminal (WP-99): the last `capacity` bytes of its output, replayed to
 * a socket on `attach`. Pushed bytes are copied into blocks the ring owns (`RING_BLOCK_BYTES`):
 * keeping the pushed buffers would pin whatever they view – a small `Buffer` lives in a shared pool
 * slab, so hours of typing (thousands of tiny chunks) could pin far more than the capacity (review
 * WP-99). Trimming drops whole blocks and slices the first one.
 *
 * Trimming prefers a line start: the cut moves to just after the first `\n` behind the hard cut
 * point when one lies within `RING_LINE_SEARCH_BYTES`; otherwise it cuts hard, skipping UTF-8
 * continuation bytes so the replay never starts inside a character. An escape sequence can still
 * be cut – the replay is followed by a resize nudge that makes conhost repaint the screen anyway.
 */
import { TERMINAL_LIMITS } from '@shared/terminal';

/** How far behind the hard cut point a line break is looked for. */
export const RING_LINE_SEARCH_BYTES = 4096;
/** Size of one block the ring copies output into. */
export const RING_BLOCK_BYTES = 16 * 1024;

const NEWLINE = 0x0a;
/** Longest run of UTF-8 continuation bytes after a lead byte. */
const UTF8_CONTINUATION_MAX = 3;

export interface ByteRing {
  /** Bytes kept now (≤ capacity). */
  readonly size: number;
  readonly capacity: number;
  /** Appends output (copied; the caller may reuse the buffer). */
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
  /** Views into owned blocks, oldest first; the last one may have room behind it in its block. */
  let chunks: Uint8Array[] = [];
  let size = 0;
  /** The block behind the last chunk and how much of it is used. */
  let tail: Uint8Array | null = null;
  let tailUsed = 0;

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
      let offset = 0;
      while (offset < data.length) {
        const last = chunks.at(-1);
        // A new block when there is none, it is full, or trimming dropped the chunk it backed.
        if (tail === null || tailUsed === tail.length || last?.buffer !== tail.buffer) {
          tail = new Uint8Array(RING_BLOCK_BYTES);
          tailUsed = 0;
          chunks.push(tail.subarray(0, 0));
        }
        const count = Math.min(tail.length - tailUsed, data.length - offset);
        tail.set(data.subarray(offset, offset + count), tailUsed);
        const view = chunks.at(-1) ?? tail.subarray(0, 0);
        chunks[chunks.length - 1] = tail.subarray(view.byteOffset, tailUsed + count);
        tailUsed += count;
        offset += count;
        size += count;
      }
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
      tail = null;
      tailUsed = 0;
    },
  };
}
