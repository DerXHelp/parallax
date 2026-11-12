import type { IncomingFiles } from '@web/lib/transfer-files';

/**
 * Folders are not attached (ADR-146: the hint says to insert their path with @). A drop or paste
 * – on the composer or on the session pane (shell request `attachFiles` with `folders`, CR3-01) –
 * knows them from its `DataTransfer` (`@web/lib/transfer-files`); a plain file list without entries
 * does not – there a dropped folder is a `File` without a type that cannot be read (Chrome rejects
 * reading it), so untyped files are probed by reading one byte (second line of defence). A chunk
 * of its own (R5W-01): the composer loads it with `import()` only when an untyped file has to be
 * probed.
 */

async function readable(file: File): Promise<boolean> {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** Drops the folders of a plain file list (untyped files that cannot be read), order kept. */
export async function withoutFolders(files: readonly File[]): Promise<IncomingFiles> {
  const checks = await Promise.all(files.map(async (file) => file.type !== '' || (await readable(file))));
  const kept = files.filter((_, index) => checks[index] === true);
  return { files: kept, folders: files.length - kept.length };
}
