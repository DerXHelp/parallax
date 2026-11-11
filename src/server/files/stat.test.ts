import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import { makeTempHome } from '../http/testServer';
import { nodeFileFs, type FileFs } from './fileFs';
import { SVG_MEDIA_TYPE, TEXT_MEDIA_TYPE, classifyFile, isPreviewable, statAllowed } from './stat';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = Buffer.from('%PDF-1.7\n');

describe('classifyFile (ADR-142)', () => {
  it.each([
    ['PNG bytes', PNG, 'shot.png', 'image', 'image/png', null],
    ['PNG bytes named .txt (magic bytes win)', PNG, 'notes.txt', 'image', 'image/png', null],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0]), 'a.jpg', 'image', 'image/jpeg', null],
    ['GIF', Buffer.from('GIF87a....'), 'a.gif', 'image', 'image/gif', null],
    ['ICO', Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]), 'favicon.ico', 'image', 'image/x-icon', null],
    ['PDF', PDF, 'doc.pdf', 'pdf', 'application/pdf', null],
    ['PDF named .md', PDF, 'doc.md', 'pdf', 'application/pdf', null],
    ['SVG by extension', Buffer.from('<svg/>'), 'logo.SVG', 'image', SVG_MEDIA_TYPE, null],
    ['UTF-8 text', Buffer.from('const x = "ä";\n'), 'main.ts', 'text', TEXT_MEDIA_TYPE, 'utf-8'],
    ['Markdown', Buffer.from('# Title\n'), 'README.md', 'markdown', TEXT_MEDIA_TYPE, 'utf-8'],
    [
      'Markdown (.markdown)',
      Buffer.from('# Title\n'),
      'notes.markdown',
      'markdown',
      TEXT_MEDIA_TYPE,
      'utf-8',
    ],
    [
      'UTF-16LE with BOM',
      Buffer.from([0xff, 0xfe, 0x41, 0x00]),
      'a.txt',
      'text',
      TEXT_MEDIA_TYPE,
      'utf-16le',
    ],
    [
      'UTF-16BE with BOM',
      Buffer.from([0xfe, 0xff, 0x00, 0x41]),
      'a.txt',
      'text',
      TEXT_MEDIA_TYPE,
      'utf-16be',
    ],
    [
      'windows-1252',
      Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]),
      'a.txt',
      'text',
      TEXT_MEDIA_TYPE,
      'windows-1252',
    ],
    ['binary (NUL)', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), 'a.zip', 'binary', null, null],
    [
      'HTML stays text',
      Buffer.from('<!doctype html><script>x</script>'),
      'a.html',
      'text',
      TEXT_MEDIA_TYPE,
      'utf-8',
    ],
    ['empty file', Buffer.alloc(0), 'empty.txt', 'text', TEXT_MEDIA_TYPE, 'utf-8'],
  ])('%s', (_name, head, name, kind, mediaType, encoding) => {
    expect(classifyFile(head, head.length, name)).toEqual({ kind, mediaType, encoding });
  });

  it('previewable: text always, image/pdf up to fileBinaryBytes, never binary/directory', () => {
    expect(isPreviewable('text', 10 * LIMITS.fileTextBytes)).toBe(true);
    expect(isPreviewable('markdown', 0)).toBe(true);
    expect(isPreviewable('image', LIMITS.fileBinaryBytes)).toBe(true);
    expect(isPreviewable('image', LIMITS.fileBinaryBytes + 1)).toBe(false);
    expect(isPreviewable('pdf', LIMITS.fileBinaryBytes + 1)).toBe(false);
    expect(isPreviewable('binary', 1)).toBe(false);
    expect(isPreviewable('directory', 0)).toBe(false);
  });
});

/** A FileFs answering one file with the given size and first bytes (no real file needed). */
function sizedFs(size: number, head: Buffer): FileFs {
  return {
    ...nodeFileFs,
    stat: () => Promise.resolve({ isFile: () => true, isDirectory: () => false, size, mtimeMs: 1000 }),
    readHead: (_file, length) => Promise.resolve(head.subarray(0, length)),
    createReadStream: () => Readable.from([]),
  };
}

describe('statAllowed', () => {
  it('real files and folders: kind, size, mtime, access as given', async () => {
    const dir = await makeTempHome('stat-');
    await mkdir(path.join(dir, 'sub'));
    const text = path.join(dir, 'a.md');
    await writeFile(text, '# Hi\n');
    const info = await statAllowed(nodeFileFs, { path: text, realPath: text, access: 'session' });
    expect(info).toMatchObject({
      path: text,
      realPath: text,
      kind: 'markdown',
      mediaType: TEXT_MEDIA_TYPE,
      bytes: 5,
      encoding: 'utf-8',
      previewable: true,
      truncated: false,
      access: 'session',
    });
    expect(info.mtimeMs).toBeGreaterThan(0);
    const folder = path.join(dir, 'sub');
    expect(await statAllowed(nodeFileFs, { path: folder, realPath: folder, access: 'cwd' })).toMatchObject({
      kind: 'directory',
      mediaType: null,
      bytes: 0,
      encoding: null,
      previewable: false,
      truncated: false,
    });
  });

  it('keeps the requested path and reports the physical one', async () => {
    const info = await statAllowed(sizedFs(4, Buffer.from('abc\n')), {
      path: 'C:\\link\\a.txt',
      realPath: 'D:\\real\\a.txt',
      access: 'cwd',
    });
    expect(info).toMatchObject({ path: 'C:\\link\\a.txt', realPath: 'D:\\real\\a.txt' });
  });

  it('limits: text over fileTextBytes is truncated, images over fileBinaryBytes are not previewable', async () => {
    const big = await statAllowed(sizedFs(LIMITS.fileTextBytes + 1, Buffer.from('line\n')), {
      path: 'C:\\p\\big.log',
      realPath: 'C:\\p\\big.log',
      access: 'cwd',
    });
    expect(big).toMatchObject({ kind: 'text', truncated: true, previewable: true });
    const atLimit = await statAllowed(sizedFs(LIMITS.fileTextBytes, Buffer.from('line\n')), {
      path: 'C:\\p\\ok.log',
      realPath: 'C:\\p\\ok.log',
      access: 'cwd',
    });
    expect(atLimit.truncated).toBe(false);
    const image = await statAllowed(sizedFs(LIMITS.fileBinaryBytes + 1, PNG), {
      path: 'C:\\p\\huge.png',
      realPath: 'C:\\p\\huge.png',
      access: 'cwd',
    });
    expect(image).toMatchObject({ kind: 'image', previewable: false, truncated: false });
  });

  it('a special file (neither file nor folder) is binary and never read', async () => {
    let reads = 0;
    const fs: FileFs = {
      ...nodeFileFs,
      stat: () => Promise.resolve({ isFile: () => false, isDirectory: () => false, size: 0, mtimeMs: 0 }),
      readHead: () => {
        reads += 1;
        return Promise.resolve(Buffer.alloc(0));
      },
    };
    expect(await statAllowed(fs, { path: 'C:\\p\\x', realPath: 'C:\\p\\x', access: 'cwd' })).toMatchObject({
      kind: 'binary',
      previewable: false,
    });
    expect(reads).toBe(0);
  });
});
