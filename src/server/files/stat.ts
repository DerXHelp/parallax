/**
 * Metadata of an allowed path (`file.stat`, ADR-142): kind by magic bytes (png, jpeg, gif, webp,
 * bmp, ico, pdf), `svg` by extension as an image, otherwise text detection on the first 64 KiB
 * (BOM, NUL → binary, valid UTF-8, fallback windows-1252); `.md`/`.markdown` text is `markdown`;
 * folders are `directory`. Called only after the access check (files/service.ts).
 *
 * `truncated` (CR3-04, ADR-157) says exactly what GET /api/file cuts (`readTextContent`): the source
 * is longer than LIMITS.fileTextBytes, or its UTF-8 form is (UTF-16, windows-1252, invalid UTF-8
 * bytes → U+FFFD). The UTF-8 size is only computed where an upper bound from size and encoding
 * leaves it open, and remembered per file version (path, size, mtime) – the polling viewer reads
 * an unchanged file once.
 */
import { isUtf8 } from 'node:buffer';
import { LIMITS } from '@shared/common';
import type { FileAccess, FileInfo, FileKind, TextEncoding } from '@shared/model';
import { windowsPathExtension, windowsPathKey } from '@shared/paths';
import { sniffFileMediaType } from '../lib/sniff';
import { TEXT_SNIFF_BYTES, bomLength, decodeText, detectTextEncoding } from '../lib/textDecode';
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

/** Remembered exact truncation results (CR3-04). */
export const TRUNCATION_CACHE_MAX = 256;

/** Exact truncation results per file version (key: physical path, size, mtime, encoding). */
export interface TruncationCache {
  get(key: string): boolean | undefined;
  set(key: string, cut: boolean): void;
}

/** A small LRU cache of exact truncation results (one per file service). */
export function createTruncationCache(max = TRUNCATION_CACHE_MAX): TruncationCache {
  const results = new Map<string, boolean>();
  return {
    get(key) {
      const cut = results.get(key);
      if (cut !== undefined) {
        results.delete(key);
        results.set(key, cut);
      }
      return cut;
    },
    set(key, cut) {
      results.delete(key);
      results.set(key, cut);
      if (results.size > max) {
        const oldest = results.keys().next();
        if (oldest.done !== true) results.delete(oldest.value);
      }
    },
  };
}

/**
 * Upper bound of the UTF-8 size of a whole text of `bytes` source bytes, decoded without a cut:
 * windows-1252 ≤ 3 bytes per byte (€ → U+20AC); UTF-16 ≤ 3 bytes per 2-byte unit (an odd last byte
 * → U+FFFD); UTF-8 ≤ 3 bytes per byte (an invalid byte → U+FFFD), except the first `validBytes`
 * the detection found valid.
 */
export function utf8SizeBound(bytes: number, encoding: TextEncoding, validBytes: number): number {
  switch (encoding) {
    case 'windows-1252':
      return 3 * bytes;
    case 'utf-16le':
    case 'utf-16be':
      return 3 * Math.ceil(bytes / 2);
    case 'utf-8': {
      const valid = Math.max(0, Math.min(validBytes, bytes));
      return valid + 3 * (bytes - valid);
    }
  }
}

/** UTF-8 size of `raw` decoded like `readTextContent` does it (BOM dropped, invalid bytes → U+FFFD). */
export function decodedUtf8Size(raw: Buffer, encoding: TextEncoding): number {
  // Valid UTF-8 decodes to the same bytes: the common case needs no string.
  if (encoding === 'utf-8' && isUtf8(raw)) return raw.length - bomLength(raw, 'utf-8');
  return Buffer.byteLength(decodeText(raw, encoding, false), 'utf8');
}

export interface StatOptions {
  /**
   * Exact `truncated` of a text whose UTF-8 form may outgrow the limit (CR3-04): computed each time
   * (default), remembered in a cache, or `'skip'` – only the source size counts (GET /api/file reads
   * and cuts the content itself and does not need the flag).
   */
  truncation?: TruncationCache | 'skip';
}

/** Does GET /api/file cut this text (see the file comment)? */
async function isTextTruncated(
  fs: FileFs,
  file: AllowedFile,
  version: { bytes: number; mtimeMs: number },
  encoding: TextEncoding,
  head: Buffer,
  truncation: StatOptions['truncation'],
): Promise<boolean> {
  const limit = LIMITS.fileTextBytes;
  const { bytes } = version;
  if (bytes > limit) return true;
  if (truncation === 'skip') return false;
  // UTF-8 without a BOM: the detection checked the head (a sequence cut at its end aside).
  const checked = encoding === 'utf-8' && bomLength(head, 'utf-8') === 0;
  const validBytes = !checked ? 0 : head.length >= bytes ? bytes : head.length - 3;
  if (utf8SizeBound(bytes, encoding, validBytes) <= limit) return false;
  const key = JSON.stringify([windowsPathKey(file.realPath), bytes, version.mtimeMs, encoding]);
  const known = truncation?.get(key);
  if (known !== undefined) return known;
  const cut = decodedUtf8Size(await fs.readHead(file.realPath, bytes), encoding) > limit;
  truncation?.set(key, cut);
  return cut;
}

/** `FileInfo` of an allowed path; fs errors propagate (the caller maps them). */
export async function statAllowed(
  fs: FileFs,
  file: AllowedFile,
  options: StatOptions = {},
): Promise<FileInfo> {
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
  const truncated =
    head !== null && cls.encoding !== null && isTextKind(cls.kind)
      ? await isTextTruncated(
          fs,
          file,
          { bytes, mtimeMs: info.mtimeMs },
          cls.encoding,
          head,
          options.truncation,
        )
      : false;
  return {
    ...base,
    kind: cls.kind,
    mediaType: cls.mediaType,
    bytes,
    encoding: cls.encoding,
    previewable: isPreviewable(cls.kind, bytes),
    truncated,
  };
}
