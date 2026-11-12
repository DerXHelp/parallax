import { describe, expect, it } from 'vitest';
import { transferFiles, withoutFolders, type FileTransfer } from './folders';

function item(file: File | null, isDirectory: boolean) {
  return {
    kind: 'file',
    getAsFile: () => file,
    webkitGetAsEntry: () => ({ isDirectory }),
  };
}

/** A DataTransfer double (happy-dom has no file entries). */
function transfer(items: ReturnType<typeof item>[], files: File[] = []): FileTransfer {
  return { items, files };
}

describe('folders are not attached (ADR-146)', () => {
  it('a drop counts folders by their entry and keeps the files', () => {
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    expect(transferFiles(transfer([item(null, true), item(file, false)]))).toEqual({
      files: [file],
      folders: 1,
    });
  });

  it('without items the plain file list is taken', () => {
    const file = new File(['x'], 'b.pdf', { type: 'application/pdf' });
    expect(transferFiles(transfer([], [file]))).toEqual({ files: [file], folders: 0 });
  });

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
