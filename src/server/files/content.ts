/**
 * Content of an allowed file for GET /api/file (ADR-142): text converted to UTF-8 and cut at the
 * last line end within LIMITS.fileTextBytes; images and PDFs read whole up to
 * LIMITS.fileBinaryBytes (larger → PAYLOAD_TOO_LARGE; CR3-05/ADR-157: `bytes` is always the exact
 * length of the body); binary files and folders → UNSUPPORTED_MEDIA_TYPE. Nothing of the content is
 * ever logged.
 */
import { Readable } from 'node:stream';
import { LIMITS } from '@shared/common';
import { makeError } from '@shared/errors';
import type { FileInfo } from '@shared/model';
import { windowsBaseName } from '@shared/paths';
import { cutUtf8AtLineEnd, decodeText } from '../lib/textDecode';
import { CommandError } from '../sync/ports';
import type { FileContent } from './ports';
import type { FileFs } from './fileFs';
import { isTextKind } from './stat';

function bufferStream(buffer: Buffer): Readable {
  return Readable.from([buffer], { objectMode: false });
}

/**
 * UTF-8 text of a file of `bytes` source bytes in `encoding`: the first LIMITS.fileTextBytes source
 * bytes, decoded, cut at a line end when the source was cut or its UTF-8 form is too long – exactly
 * what `truncated` of file.stat predicts (stat.ts, CR3-04).
 */
export async function readTextContent(fs: FileFs, file: FileInfo): Promise<Buffer> {
  const limit = LIMITS.fileTextBytes;
  const sourceCut = file.bytes > limit;
  const raw = await fs.readHead(file.realPath, Math.min(file.bytes, limit));
  const text = decodeText(raw, file.encoding ?? 'utf-8', sourceCut);
  return cutUtf8AtLineEnd(Buffer.from(text, 'utf8'), limit, sourceCut);
}

/** The answer of GET /api/file for a stat'ed, allowed file (see the file comment). */
export async function openContent(fs: FileFs, file: FileInfo): Promise<FileContent> {
  const name = windowsBaseName(file.path) || windowsBaseName(file.realPath);
  if (isTextKind(file.kind)) {
    const body = await readTextContent(fs, file);
    return {
      stream: bufferStream(body),
      mediaType: file.mediaType ?? 'text/plain; charset=utf-8',
      bytes: body.length,
      name,
      policy: 'blob',
    };
  }
  if ((file.kind === 'image' || file.kind === 'pdf') && file.mediaType !== null) {
    if (file.bytes > LIMITS.fileBinaryBytes) throw new CommandError(makeError('PAYLOAD_TOO_LARGE'));
    // CR3-05: read whole through one handle – Content-Length is the length of exactly these bytes,
    // also when the file was replaced, shrank or grew since the stat (no stale length, no stale end).
    const data = await fs.readWhole(file.realPath, LIMITS.fileBinaryBytes);
    if (data === null) throw new CommandError(makeError('PAYLOAD_TOO_LARGE'));
    return {
      stream: bufferStream(data),
      mediaType: file.mediaType,
      bytes: data.length,
      name,
      policy: file.kind === 'pdf' ? 'pdf' : 'blob',
    };
  }
  throw new CommandError(makeError('UNSUPPORTED_MEDIA_TYPE'));
}
