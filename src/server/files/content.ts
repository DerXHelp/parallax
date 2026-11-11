/**
 * Content of an allowed file for GET /api/file (ADR-142): text converted to UTF-8 and cut at the
 * last line end within LIMITS.fileTextBytes; images and PDFs as a stream up to
 * LIMITS.fileBinaryBytes (larger → PAYLOAD_TOO_LARGE); binary files and folders →
 * UNSUPPORTED_MEDIA_TYPE. Nothing of the content is ever logged.
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
 * bytes, decoded, cut at a line end when the source was cut or its UTF-8 form is too long.
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
    return {
      stream:
        file.bytes === 0 ? bufferStream(Buffer.alloc(0)) : fs.createReadStream(file.realPath, file.bytes),
      mediaType: file.mediaType,
      bytes: file.bytes,
      name,
      policy: file.kind === 'pdf' ? 'pdf' : 'blob',
    };
  }
  throw new CommandError(makeError('UNSUPPORTED_MEDIA_TYPE'));
}
