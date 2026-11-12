/**
 * Folders are not attached (ADR-146: the hint says to insert their path with @). A drop or paste
 * on the composer knows them from its `DataTransfer` (`webkitGetAsEntry().isDirectory`); a plain
 * file list (shell request `attachFiles` of the session drop zone, WP-58) does not – there a
 * dropped folder is a `File` without a type that cannot be read (Chrome rejects reading it), so
 * untyped files are probed by reading one byte.
 */

export interface IncomingFiles {
  files: File[];
  /** Folders that were left out. */
  folders: number;
}

/** The part of a `DataTransfer` item read here (`webkitGetAsEntry` is missing in test DOMs). */
interface TransferItem {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?: () => { isDirectory: boolean } | null;
}

/** The part of a `DataTransfer` read here (test doubles may come without `items`). */
export interface FileTransfer {
  items?: ArrayLike<TransferItem>;
  files: ArrayLike<File>;
}

/** Files of a drop or paste; folders counted, not taken. */
export function transferFiles(data: FileTransfer): IncomingFiles {
  const fileItems = Array.from(data.items ?? []).filter((item) => item.kind === 'file');
  if (fileItems.length === 0) return { files: Array.from(data.files), folders: 0 };
  const files: File[] = [];
  let folders = 0;
  for (const item of fileItems) {
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory === true) {
      folders += 1;
      continue;
    }
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  return { files, folders };
}

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
