/**
 * Reads the first bytes of a file (Phase 3: type sniffing of the file service, PE header of
 * `spawnGui`). Never touches an unsafe string (C.10) – callers check the path before anyway.
 *
 * POSIX (WP-103): only regular files are read. `open` of a FIFO for reading would wait for a writer
 * (and with it a thread of the libuv pool), a device could be anything – so the file is opened with
 * `O_NONBLOCK` (no effect on regular files) and checked with `fstat` on the open handle (no race
 * between a check and the open) → `PATH_REJECTED {reason: 'not_regular'}`. Windows unchanged.
 */
import { constants } from 'node:fs';
import { open, readlink, type FileHandle } from 'node:fs/promises';
import type { CommandError } from '../sync/ports';
import { assertSafePath, linkTargetRejected, notRegularFileRejected } from './paths';

/**
 * Opens `file` for reading (path rules of this host first). POSIX: a FIFO, socket, device or folder
 * is closed again and rejected with `PATH_REJECTED {reason: 'not_regular'}` before a byte is read.
 * The caller closes the handle.
 */
export interface OpenRegularOptions {
  /**
   * Follow-up of the security review WP-109: `file` is a physical path (`realpath`, checked by
   * `resolveAllowedPath`). Linux: the open file must still be exactly there (`/proc/self/fd/<fd>`);
   * otherwise a link swapped in between the check and the open (by a process of the same user) led
   * elsewhere – into `/proc`, out of the project – and the read is refused with
   * `PATH_REJECTED {reason: 'link_target'}`. Without a readable `/proc` the check is skipped.
   */
  physical?: boolean;
  /** Test seam (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** Test seam: the path the kernel names for the open handle; null = unknown. */
  openedPath?: (handle: FileHandle) => Promise<string | null>;
}

async function procOpenedPath(handle: FileHandle): Promise<string | null> {
  try {
    return await readlink(`/proc/self/fd/${String(handle.fd)}`);
  } catch {
    return null;
  }
}

export async function openRegularFile(file: string, options: OpenRegularOptions = {}): Promise<FileHandle> {
  assertSafePath(file);
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return open(file, 'r');
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  let problem: CommandError | null = notRegularFileRejected();
  try {
    if ((await handle.stat()).isFile()) problem = null;
    if (problem === null && options.physical === true && platform === 'linux') {
      const opened = await (options.openedPath ?? procOpenedPath)(handle);
      if (opened !== null && opened !== file) problem = linkTargetRejected();
    }
  } finally {
    if (problem !== null) await handle.close();
  }
  if (problem !== null) throw problem;
  return handle;
}

/** Up to `length` bytes from the start of `file` (fewer at the end of the file). */
export async function readFileHead(
  file: string,
  length: number,
  options: OpenRegularOptions = {},
): Promise<Buffer> {
  const size = Math.max(0, Math.floor(length));
  const handle = await openRegularFile(file, options);
  try {
    const buffer = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const { bytesRead } = await handle.read(buffer, filled, size - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}
