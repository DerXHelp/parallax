/**
 * `GET /api/notices` (WP-87 §1.4, docs/wp/WP-83.md §3.5/§3.6): the license and the third-party
 * notices of the RUNNING version – fixed files of its folder (`repoRoot`), never a path from the
 * request. A checkout has no THIRD_PARTY_NOTICES.md (release-pack writes it) → FILE_NOT_FOUND.
 */
import path from 'node:path';
import { makeError } from '@shared/errors';
import type { NoticeFile, NoticesResponse } from '@shared/http';
import { readFileHead } from '../lib/fileRead';
import { fsErrorCode } from '../lib/paths';
import { CommandError } from '../sync/ports';

export const NOTICE_FILE_NAMES: Readonly<Record<NoticeFile, string>> = {
  license: 'LICENSE',
  'third-party': 'THIRD_PARTY_NOTICES.md',
};
/** `noticesResponseSchema.text` holds at most 16 000 000 characters (UTF-8: at most as many bytes). */
export const NOTICE_MAX_BYTES = 16_000_000;

/**
 * A fixed text file of the running version, at most `maxBytes` (UTF-8, without BOM). Throws
 * `CommandError`: FILE_NOT_FOUND (missing), PAYLOAD_TOO_LARGE (larger), FILE_NOT_READABLE (else).
 */
export async function readFixedText(file: string, maxBytes: number): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFileHead(file, maxBytes + 1);
  } catch (error) {
    if (error instanceof CommandError) throw error; // PATH_REJECTED of readFileHead
    const code = fsErrorCode(error);
    throw new CommandError(
      code === 'ENOENT' || code === 'ENOTDIR'
        ? makeError('FILE_NOT_FOUND')
        : makeError('FILE_NOT_READABLE', { reason: code === 'EBUSY' ? 'busy' : 'access' }),
    );
  }
  if (bytes.length > maxBytes) throw new CommandError(makeError('PAYLOAD_TOO_LARGE'));
  const text = bytes.toString('utf8');
  return text.startsWith('﻿') ? text.slice(1) : text;
}

/** LICENSE or THIRD_PARTY_NOTICES.md from `repoRoot`. */
export async function readNotice(repoRoot: string, file: NoticeFile): Promise<NoticesResponse> {
  return { file, text: await readFixedText(path.join(repoRoot, NOTICE_FILE_NAMES[file]), NOTICE_MAX_BYTES) };
}
