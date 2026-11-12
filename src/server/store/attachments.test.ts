import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { windowsPathIssue } from '@shared/paths';
import { SAMPLE_IDS } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import { nodeFsOps, type FsOps } from '../lib/fs';
import { CommandError } from '../sync/ports';
import {
  ATTACHMENT_NAME_MAX,
  attachmentsDir,
  createAttachmentFileStore,
  sanitizeAttachmentName,
} from './attachments';
import { createBlobStore, type FileBlobStore } from './blobs';

const ENTRY = SAMPLE_IDS.entry;
let blobs: FileBlobStore | null = null;

afterEach(async () => {
  await blobs?.close();
  blobs = null;
});

async function setup() {
  const home = await makeTempHome('attachments-');
  blobs = createBlobStore({ home });
  const writes: string[] = [];
  const fs: FsOps = {
    ...nodeFsOps,
    writeFile: (file, data) => {
      writes.push(file);
      return nodeFsOps.writeFile(file, data);
    },
  };
  return { home, blobs, writes, store: createAttachmentFileStore(home, blobs, { fs }) };
}

describe('sanitizeAttachmentName (ADR-146)', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['Grüße 2026.txt', 'Grüße 2026.txt'],
    ['a<b>c:d"e|f?g*h.txt', 'a_b_c_d_e_f_g_h.txt'],
    ['C:\\Users\\me\\secret.txt', 'secret.txt'],
    ['../../evil.txt', 'evil.txt'],
    ['dir/sub/file.md', 'file.md'],
    ['tab\tname\u0007.txt', 'tab_name_.txt'],
    ['name. . ', 'name'],
    ['  leading.txt', 'leading.txt'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['COM1.log', '_COM1.log'],
    ['Lpt9', '_Lpt9'],
    ['file.txt:stream', 'file.txt_stream'],
  ])('%j → %j', (input, expected) => {
    const safe = sanitizeAttachmentName(input);
    expect(safe).toBe(expected);
    expect(windowsPathIssue(`C:\\x\\${String(safe)}`)).toBeNull();
  });

  it.each([null, '', '...', '   ', 'dir\\', '. .'])('%j → null (nothing usable left)', (input) => {
    expect(sanitizeAttachmentName(input)).toBeNull();
  });

  it(`cuts long names to ${String(ATTACHMENT_NAME_MAX)} characters, keeping the extension and surrogate pairs`, () => {
    const long = sanitizeAttachmentName(`${'a'.repeat(300)}.txt`);
    expect(long).toHaveLength(ATTACHMENT_NAME_MAX);
    expect(long?.endsWith('.txt')).toBe(true);
    const emoji = sanitizeAttachmentName(`${'a'.repeat(ATTACHMENT_NAME_MAX - 5)}😀😀😀.md`);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(emoji?.endsWith('.md')).toBe(true);
    expect((emoji ?? '').length).toBeLessThanOrEqual(ATTACHMENT_NAME_MAX);
  });
});

describe('createAttachmentFileStore', () => {
  it('dir: <home>\\entries\\<entryId>\\attachments, created on demand', async () => {
    const { home, store } = await setup();
    const dir = await store.dir(ENTRY);
    expect(dir).toBe(path.join(home, 'entries', ENTRY, 'attachments'));
    expect(dir).toBe(attachmentsDir(home, ENTRY));
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('materialize copies the blob to <dir>\\<blob16>\\<safe name> – idempotent', async () => {
    const { home, blobs: store0, writes, store } = await setup();
    const ref = store0.put(Buffer.from('zip-bytes'), 'application/octet-stream', 'a:b.zip');
    const target = await store.materialize(ENTRY, ref.blobId, 'a:b.zip');
    expect(target).toBe(path.join(attachmentsDir(home, ENTRY), ref.blobId.slice(0, 16), 'a_b.zip'));
    expect(await readFile(target, 'utf8')).toBe('zip-bytes');
    const firstWrites = writes.length;
    expect(firstWrites).toBeGreaterThan(0);
    // Same content, same name, same size: nothing is written again.
    expect(await store.materialize(ENTRY, ref.blobId, 'a:b.zip')).toBe(target);
    expect(writes.length).toBe(firstWrites);
  });

  it.each([
    [null, 'application/octet-stream', 'bin'],
    ['...', 'application/pdf', 'pdf'],
    [null, 'image/jpeg', 'jpg'],
    [null, 'image/png', 'png'],
  ])('falls back to <blob16>.<ext> for the name %j (%s)', async (name, mediaType, ext) => {
    const { blobs: store0, store } = await setup();
    const ref = store0.put(Buffer.from(`bytes ${mediaType}`), mediaType, null);
    const target = await store.materialize(ENTRY, ref.blobId, name);
    expect(path.basename(target)).toBe(`${ref.blobId.slice(0, 16)}.${ext}`);
  });

  it('BLOB_NOT_FOUND for an unknown or malformed blob id', async () => {
    const { store } = await setup();
    for (const blobId of ['0'.repeat(64), '..\\..\\x']) {
      const error = await store.materialize(ENTRY, blobId, 'x.txt').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CommandError);
      expect(error).toMatchObject({ error: { code: 'BLOB_NOT_FOUND', params: {} } });
    }
  });
});
