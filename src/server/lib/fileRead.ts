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
import { open, type FileHandle } from 'node:fs/promises';
import { assertSafePath, notRegularFileRejected } from './paths';

/**
 * Opens `file` for reading (path rules of this host first). POSIX: a FIFO, socket, device or folder
 * is closed again and rejected with `PATH_REJECTED {reason: 'not_regular'}` before a byte is read.
 * The caller closes the handle.
 */
export async function openRegularFile(file: string): Promise<FileHandle> {
  assertSafePath(file);
  if (process.platform === 'win32') return open(file, 'r');
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  let regular = false;
  try {
    regular = (await handle.stat()).isFile();
  } finally {
    if (!regular) await handle.close();
  }
  if (!regular) throw notRegularFileRejected();
  return handle;
}

/** Up to `length` bytes from the start of `file` (fewer at the end of the file). */
export async function readFileHead(file: string, length: number): Promise<Buffer> {
  const size = Math.max(0, Math.floor(length));
  const handle = await openRegularFile(file);
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
