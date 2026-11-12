/**
 * Reads the first bytes of a file (Phase 3: type sniffing of the file service, PE header of
 * `spawnGui`). Never touches an unsafe string (C.10) – callers check the path before anyway.
 */
import { open } from 'node:fs/promises';
import { assertSafePath } from './paths';

/** Up to `length` bytes from the start of `file` (fewer at the end of the file). */
export async function readFileHead(file: string, length: number): Promise<Buffer> {
  assertSafePath(file);
  const size = Math.max(0, Math.floor(length));
  const handle = await open(file, 'r');
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
