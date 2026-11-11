import {
  FileCodeIcon,
  FileIcon as GenericFileIcon,
  FileImageIcon,
  FileTextIcon,
  FileTypeIcon,
  FolderIcon,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { createElement } from 'react';
import type { FileKind } from '@shared/model';
import { windowsPathExtension } from '@shared/paths';
import { languageForPath } from '@web/lib/languages';

const KIND_ICONS: Readonly<Record<FileKind, LucideIcon>> = {
  text: FileTextIcon,
  markdown: FileTextIcon,
  image: FileImageIcon,
  pdf: FileTypeIcon,
  binary: GenericFileIcon,
  directory: FolderIcon,
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);

/** Icon of a file: by its kind when known (stat), else guessed from the extension. */
export function fileIconFor(path: string, kind: FileKind | null = null): LucideIcon {
  if (kind !== null)
    return kind === 'text' && languageForPath(path) !== null ? FileCodeIcon : KIND_ICONS[kind];
  const extension = windowsPathExtension(path);
  if (IMAGE_EXTENSIONS.has(extension)) return FileImageIcon;
  if (extension === 'pdf') return FileTypeIcon;
  if (extension === 'md' || extension === 'markdown' || extension === 'txt' || extension === 'log') {
    return FileTextIcon;
  }
  return languageForPath(path) === null ? GenericFileIcon : FileCodeIcon;
}

export function FileIcon({
  path,
  kind = null,
  ...props
}: { path: string; kind?: FileKind | null } & LucideProps) {
  // createElement: the icon is one of the static lucide components above, not created here.
  return createElement(fileIconFor(path, kind), { 'aria-hidden': true, ...props });
}
