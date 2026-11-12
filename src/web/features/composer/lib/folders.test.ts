import { describe, expect, it } from 'vitest';
import { withoutFolders } from './folders';

describe('folders are not attached (ADR-146)', () => {
  it('a plain file list: untyped files that cannot be read are folders', async () => {
    const readableFile = new File(['data'], 'Makefile', { type: '' });
    const typed = new File(['x'], 'c.png', { type: 'image/png' });
    const folder = new File([], 'src', { type: '' });
    Object.defineProperty(folder, 'slice', {
      value: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }),
    });
    await expect(withoutFolders([readableFile, folder, typed])).resolves.toEqual({
      files: [readableFile, typed],
      folders: 1,
    });
  });
});
