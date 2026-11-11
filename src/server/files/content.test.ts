import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import type { FileInfo } from '@shared/model';
import { sampleFileInfo } from '@shared/samples';
import { CommandError } from '../sync/ports';
import { openContent, readTextContent } from './content';
import { nodeFileFs, type FileFs } from './fileFs';

/** A FileFs serving `data` for any path; `streams` records createReadStream calls. */
function dataFs(data: Buffer): FileFs & { streams: number[]; heads: number[] } {
  const streams: number[] = [];
  const heads: number[] = [];
  return {
    ...nodeFileFs,
    streams,
    heads,
    readHead: (_file, length) => {
      heads.push(length);
      return Promise.resolve(data.subarray(0, length));
    },
    createReadStream: (_file, bytes) => {
      streams.push(bytes);
      return Readable.from([data.subarray(0, bytes)]);
    },
  };
}

async function body(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

function textInfo(bytes: number, p: Partial<FileInfo> = {}): FileInfo {
  return sampleFileInfo({ bytes, truncated: bytes > LIMITS.fileTextBytes, ...p });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CommandError);
  expect(error).toMatchObject({ error: { code } });
}

describe('openContent – text (ADR-142)', () => {
  it('UTF-8 text as is, with the requested base name and the blob header set', async () => {
    const data = Buffer.from('const x = 1;\n');
    const content = await openContent(dataFs(data), textInfo(data.length));
    expect(content).toMatchObject({
      mediaType: 'text/plain; charset=utf-8',
      bytes: data.length,
      name: 'main.ts',
      policy: 'blob',
    });
    expect((await body(content.stream)).toString()).toBe('const x = 1;\n');
  });

  it('UTF-16LE, UTF-16BE and windows-1252 become UTF-8 (BOM dropped)', async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Grüße\n', 'utf16le')]);
    expect(
      (await readTextContent(dataFs(le), textInfo(le.length, { encoding: 'utf-16le' }))).toString(),
    ).toBe('Grüße\n');
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Hi\n', 'utf16le').swap16()]);
    expect(
      (await readTextContent(dataFs(be), textInfo(be.length, { encoding: 'utf-16be' }))).toString(),
    ).toBe('Hi\n');
    const cp = Buffer.from([0x80, 0x20, 0xe4, 0x0a]);
    expect(
      (await readTextContent(dataFs(cp), textInfo(cp.length, { encoding: 'windows-1252' }))).toString(),
    ).toBe('€ ä\n');
  });

  it('text over fileTextBytes: only that many source bytes read, cut at the last line end', async () => {
    const line = `${'x'.repeat(99)}\n`;
    const data = Buffer.from(line.repeat(Math.ceil(LIMITS.fileTextBytes / 100) + 10));
    const fs = dataFs(data);
    const content = await openContent(fs, textInfo(data.length));
    const text = await body(content.stream);
    expect(fs.heads).toEqual([LIMITS.fileTextBytes]);
    expect(text.length).toBeLessThanOrEqual(LIMITS.fileTextBytes);
    expect(text.length).toBe(content.bytes);
    expect(text.length % 100).toBe(0);
    expect(text.at(-1)).toBe(0x0a);
  });

  it('a windows-1252 text whose UTF-8 form outgrows the limit is cut at a line end as well', async () => {
    const line = Buffer.concat([Buffer.alloc(99, 0xe4), Buffer.from([0x0a])]); // 99 × ä → 198 UTF-8 bytes
    const count = Math.floor(LIMITS.fileTextBytes / 100);
    const data = Buffer.concat(Array.from({ length: count }, () => line));
    const text = await readTextContent(dataFs(data), textInfo(data.length, { encoding: 'windows-1252' }));
    expect(text.length).toBeLessThanOrEqual(LIMITS.fileTextBytes);
    expect(text.at(-1)).toBe(0x0a);
    expect(text.toString('utf8').split('\n')[0]).toBe('ä'.repeat(99));
  });
});

describe('openContent – images, PDFs, others', () => {
  it('an image is streamed with its type; a PDF gets the pdf header set', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fs = dataFs(png);
    const image = await openContent(
      fs,
      sampleFileInfo({
        path: 'C:\\p\\a.png',
        kind: 'image',
        mediaType: 'image/png',
        bytes: png.length,
        encoding: null,
      }),
    );
    expect(image).toMatchObject({ mediaType: 'image/png', bytes: png.length, name: 'a.png', policy: 'blob' });
    expect((await body(image.stream)).equals(png)).toBe(true);
    expect(fs.streams).toEqual([png.length]);
    const pdf = await openContent(
      dataFs(Buffer.from('%PDF-1.7')),
      sampleFileInfo({
        path: 'C:\\p\\d.pdf',
        kind: 'pdf',
        mediaType: 'application/pdf',
        bytes: 8,
        encoding: null,
      }),
    );
    expect(pdf).toMatchObject({ policy: 'pdf', mediaType: 'application/pdf', name: 'd.pdf' });
  });

  it('an empty image opens no stream on the file', async () => {
    const fs = dataFs(Buffer.alloc(0));
    const content = await openContent(
      fs,
      sampleFileInfo({ kind: 'image', mediaType: 'image/png', bytes: 0 }),
    );
    expect((await body(content.stream)).length).toBe(0);
    expect(fs.streams).toEqual([]);
  });

  it('PAYLOAD_TOO_LARGE over fileBinaryBytes, UNSUPPORTED_MEDIA_TYPE for binary files and folders', async () => {
    const fs = dataFs(Buffer.alloc(0));
    await expectCode(
      openContent(
        fs,
        sampleFileInfo({ kind: 'image', mediaType: 'image/png', bytes: LIMITS.fileBinaryBytes + 1 }),
      ),
      'PAYLOAD_TOO_LARGE',
    );
    await expectCode(
      openContent(fs, sampleFileInfo({ kind: 'binary', mediaType: null })),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    await expectCode(
      openContent(fs, sampleFileInfo({ kind: 'directory', mediaType: null })),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expect(fs.streams).toEqual([]);
  });
});
