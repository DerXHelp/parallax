/**
 * File system seam of the file service (WP-53): every call on a user path goes through here, so
 * tests can count calls (L15: a rejected path never reaches the file system), fake links and hang
 * a drive. `guardFileFs` puts the 3 s timeout of ADR-141 on every call but `readWhole` (see there).
 */
import { open, readdir, stat } from 'node:fs/promises';
import type { FsCallGuard } from '../lib/fsTimeout';
import { readFileHead } from '../lib/fileRead';
import { assertSafePath, nodeAccessFs, type AccessFs } from '../lib/paths';

export interface FileStats {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
}

export interface FileDirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  /** Junctions report true as well (Node on Windows). */
  isSymbolicLink(): boolean;
}

export interface FileFs extends AccessFs {
  /** Follows links (callers pass physical paths). */
  stat(path: string): Promise<FileStats>;
  /** Up to `length` bytes from the start of the file. */
  readHead(path: string, length: number): Promise<Buffer>;
  /**
   * The whole file, read through one handle until its end (CR3-05); null when it holds more than
   * `max` bytes. The length is that of the bytes read – also when the file changed since a stat.
   */
  readWhole(path: string, max: number): Promise<Buffer | null>;
  readdir(path: string): Promise<FileDirEntry[]>;
}

/** Read size per call once a file turns out longer than the stat of its handle said. */
const GROWTH_CHUNK_BYTES = 64 * 1024;

/** `FileFs.readWhole` on the real file system (size from the open handle, then up to the end). */
export async function readWholeFile(file: string, max: number): Promise<Buffer | null> {
  assertSafePath(file);
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size > max) return null;
    const first = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const { bytesRead } = await handle.read(first, filled, size - filled, filled);
      // Shrank meanwhile: what is there now.
      if (bytesRead === 0) return first.subarray(0, filled);
      filled += bytesRead;
    }
    // Grew meanwhile: read on to the end (or beyond the limit).
    const chunks = [first];
    let total = size;
    for (;;) {
      const chunk = Buffer.alloc(GROWTH_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > max) return null;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return chunks.length === 1 ? first : Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export const nodeFileFs: FileFs = {
  ...nodeAccessFs,
  stat: (file) => stat(file),
  readHead: (file, length) => readFileHead(file, length),
  readWhole: (file, max) => readWholeFile(file, max),
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
};

/**
 * `fs` with the timeout of `guard` on every call except `readWhole`: like the stream it replaces
 * (CR3-05) it reads a file whose stat and head just answered in time, and an image/PDF of up to
 * LIMITS.fileBinaryBytes on a slow drive may take longer than 3 s (ADR-157).
 */
export function guardFileFs(fs: FileFs, guard: FsCallGuard): FileFs {
  return {
    lstat: (file) => guard.run(file, () => fs.lstat(file)),
    readlink: (file) => guard.run(file, () => fs.readlink(file)),
    realpath: (file) => guard.run(file, () => fs.realpath(file)),
    stat: (file) => guard.run(file, () => fs.stat(file)),
    readHead: (file, length) => guard.run(file, () => fs.readHead(file, length)),
    readWhole: (file, max) => fs.readWhole(file, max),
    readdir: (dir) => guard.run(dir, () => fs.readdir(dir)),
  };
}
