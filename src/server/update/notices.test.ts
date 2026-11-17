import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandError } from '../sync/ports';
import { NOTICE_FILE_NAMES, readFixedText, readNotice } from './notices';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp87a-notices-'));
  temps.push(dir);
  return dir;
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof CommandError)) throw new Error('expected a CommandError');
  return error.error.code;
}

describe('readNotice / readFixedText', () => {
  it('reads only the fixed files of the folder', async () => {
    const dir = await temp();
    await writeFile(path.join(dir, NOTICE_FILE_NAMES.license), 'MIT License');
    await writeFile(
      path.join(dir, NOTICE_FILE_NAMES['third-party']),
      `${String.fromCharCode(0xfeff)}# Notices`,
    );
    expect(await readNotice(dir, 'license')).toEqual({ file: 'license', text: 'MIT License' });
    expect(await readNotice(dir, 'third-party')).toEqual({ file: 'third-party', text: '# Notices' });
  });

  it('maps missing, too large and refused paths to error codes', async () => {
    const dir = await temp();
    expect(await code(readNotice(dir, 'third-party'))).toBe('FILE_NOT_FOUND');
    await writeFile(path.join(dir, 'LICENSE'), 'MIT License');
    expect(await code(readFixedText(path.join(dir, 'LICENSE'), 5))).toBe('PAYLOAD_TOO_LARGE');
    expect(await code(readFixedText(path.join(dir, 'LICENSE', 'x'), 5))).toBe('FILE_NOT_FOUND');
    expect(await code(readFixedText('\\\\server\\share\\LICENSE', 5))).toBe('PATH_REJECTED');
  });
});
