/**
 * File system seam of the file service (WP-53): every call on a user path goes through here, so
 * tests can count calls (L15: a rejected path never reaches the file system), fake links and hang
 * a drive. `guardFileFs` puts the 3 s timeout of ADR-141 on every call (lib/fsTimeout.ts).
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
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
  /** Bytes `0 … bytes - 1` (bytes > 0). */
  createReadStream(path: string, bytes: number): Readable;
  readdir(path: string): Promise<FileDirEntry[]>;
}

export const nodeFileFs: FileFs = {
  ...nodeAccessFs,
  stat: (file) => stat(file),
  readHead: (file, length) => readFileHead(file, length),
  createReadStream: (file, bytes) => {
    assertSafePath(file);
    return createReadStream(file, { start: 0, end: bytes - 1 });
  },
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
};

/** `fs` with the timeout of `guard` on every promise call (the stream opens a file already read). */
export function guardFileFs(fs: FileFs, guard: FsCallGuard): FileFs {
  return {
    lstat: (file) => guard.run(file, () => fs.lstat(file)),
    readlink: (file) => guard.run(file, () => fs.readlink(file)),
    realpath: (file) => guard.run(file, () => fs.realpath(file)),
    stat: (file) => guard.run(file, () => fs.stat(file)),
    readHead: (file, length) => guard.run(file, () => fs.readHead(file, length)),
    createReadStream: (file, bytes) => fs.createReadStream(file, bytes),
    readdir: (dir) => guard.run(dir, () => fs.readdir(dir)),
  };
}
