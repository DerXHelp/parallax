/**
 * Metadata of an allowed path (`file.stat`, ADR-142): kind by magic bytes (png, jpeg, gif, webp,
 * bmp, ico, pdf), `svg` by extension as an image, otherwise text detection on the first 64 KiB
 * (BOM, NUL → binary, valid UTF-8, fallback windows-1252); `.md`/`.markdown` text is `markdown`;
 * folders are `directory`. Called only after the access check (files/service.ts).
 */
import { LIMITS } from '@shared/common';
import type { FileAccess, FileInfo, FileKind, TextEncoding } from '@shared/model';
import { windowsPathExtension } from '@shared/paths';
import { sniffFileMediaType } from '../lib/sniff';
import { TEXT_SNIFF_BYTES, detectTextEncoding } from '../lib/textDecode';
import type { FileFs } from './fileFs';

/** Content-Type of every text answer of GET /api/file (also Markdown, HTML, SVG source; ADR-142). */
export const TEXT_MEDIA_TYPE = 'text/plain; charset=utf-8';
export const SVG_MEDIA_TYPE = 'image/svg+xml';
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown']);

export interface FileClass {
  kind: FileKind;
  /** null = not served by GET /api/file. */
  mediaType: string | null;
  encoding: TextEncoding | null;
}

/**
 * Kind of a regular file from its first bytes (`head`), its size and its name (extension of the
 * requested path – the name the user sees).
 */
export function classifyFile(head: Uint8Array, size: number, name: string): FileClass {
  const sniffed = sniffFileMediaType(head);
  if (sniffed === 'application/pdf') return { kind: 'pdf', mediaType: sniffed, encoding: null };
  if (sniffed !== null) return { kind: 'image', mediaType: sniffed, encoding: null };
  const extension = windowsPathExtension(name);
  if (extension === 'svg') return { kind: 'image', mediaType: SVG_MEDIA_TYPE, encoding: null };
  const encoding = detectTextEncoding(head, head.length >= size);
  if (encoding === 'binary') return { kind: 'binary', mediaType: null, encoding: null };
  const kind: FileKind = MARKDOWN_EXTENSIONS.has(extension) ? 'markdown' : 'text';
  return { kind, mediaType: TEXT_MEDIA_TYPE, encoding };
}

export function isTextKind(kind: FileKind): boolean {
  return kind === 'text' || kind === 'markdown';
}

/** The viewer can show it: text always, image/pdf up to LIMITS.fileBinaryBytes (ADR-142). */
export function isPreviewable(kind: FileKind, bytes: number): boolean {
  if (isTextKind(kind)) return true;
  if (kind === 'image' || kind === 'pdf') return bytes <= LIMITS.fileBinaryBytes;
  return false;
}

/** An allowed path (result of the access check). */
export interface AllowedFile {
  /** As requested. */
  path: string;
  realPath: string;
  access: FileAccess;
}

/** `FileInfo` of an allowed path; fs errors propagate (the caller maps them). */
export async function statAllowed(fs: FileFs, file: AllowedFile): Promise<FileInfo> {
  const info = await fs.stat(file.realPath);
  const base = { path: file.path, realPath: file.realPath, mtimeMs: info.mtimeMs, access: file.access };
  if (info.isDirectory()) {
    return {
      ...base,
      kind: 'directory',
      mediaType: null,
      bytes: 0,
      encoding: null,
      previewable: false,
      truncated: false,
    };
  }
  const bytes = info.size;
  const head = info.isFile() ? await fs.readHead(file.realPath, Math.min(bytes, TEXT_SNIFF_BYTES)) : null;
  const cls: FileClass =
    head === null
      ? { kind: 'binary', mediaType: null, encoding: null }
      : classifyFile(head, bytes, file.path);
  return {
    ...base,
    kind: cls.kind,
    mediaType: cls.mediaType,
    bytes,
    encoding: cls.encoding,
    previewable: isPreviewable(cls.kind, bytes),
    // The UTF-8 form of a UTF-16/windows-1252 text can be longer; GET /api/file cuts that too.
    truncated: isTextKind(cls.kind) && bytes > LIMITS.fileTextBytes,
  };
}
