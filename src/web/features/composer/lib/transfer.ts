/**
 * Files of a drop or paste on the composer (ADR-146). A `DataTransfer` can only be read while its
 * event runs, so this part stays in the composer's chunk; folders are known from their entry
 * (`webkitGetAsEntry().isDirectory`), counted and left out (the hint says to insert their path
 * with @). Probing a plain file list for folders is `lib/folders.ts` (loaded on demand).
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

/** Files of a drop or paste; folders counted, not taken. Call it inside the event. */
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
