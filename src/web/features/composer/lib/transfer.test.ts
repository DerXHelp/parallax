import { describe, expect, it } from 'vitest';
import { transferFiles, type FileTransfer } from './transfer';

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

describe('files of a drop or paste (ADR-146)', () => {
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
});
