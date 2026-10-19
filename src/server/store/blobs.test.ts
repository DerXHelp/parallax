import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { blobRefSchema } from '@shared/model';
import { makeTempHome } from '../http/testServer';
import { blobMetaPath, createBlobStore } from './blobs';

describe('BlobStore.put with the pixel size (Phase 2, ADR-103)', () => {
  it('stores width/height in the ref and the meta file', async () => {
    const home = await makeTempHome('blobs-size-');
    const blobs = createBlobStore({ home });
    const ref = blobs.put(Uint8Array.from([1, 2, 3]), 'image/png', 'a.png', { width: 640, height: 480 });
    expect(ref).toMatchObject({ mediaType: 'image/png', name: 'a.png', width: 640, height: 480, bytes: 3 });
    await blobs.flush();
    const meta = blobRefSchema.parse(JSON.parse(await readFile(blobMetaPath(home, ref.blobId), 'utf8')));
    expect(meta).toEqual(ref);
    expect((await blobs.get(ref.blobId))?.ref).toEqual(ref);
    await blobs.close();
  });

  it.each([
    ['no size', undefined],
    ['null', null],
    ['zero', { width: 0, height: 10 }],
    ['a fraction', { width: 1.5, height: 10 }],
    ['NaN', { width: Number.NaN, height: 10 }],
  ])('%s → width/height null, never a throw (R1-20)', async (_name, size) => {
    const home = await makeTempHome('blobs-size-');
    const blobs = createBlobStore({ home });
    const ref = blobs.put('x', 'image/png', null, size);
    expect(ref).toMatchObject({ width: null, height: null });
    await blobs.close();
  });

  it('content without the claimed image type: the first ref wins (also against a later upload-like put)', async () => {
    const home = await makeTempHome('blobs-size-');
    const blobs = createBlobStore({ home });
    const first = blobs.put('same', 'image/png', 'first.png', { width: 10, height: 10 });
    expect(blobs.put('same', 'image/png', 'second.png', { width: 20, height: 20 })).toEqual(first);
    await blobs.close();
  });
});

describe('CR2-07: which meta of a content wins', () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const readMeta = async (home: string, blobId: string) =>
    blobRefSchema.parse(JSON.parse(await readFile(blobMetaPath(home, blobId), 'utf8')));

  it('the type the magic bytes show replaces another stored type (memory, get and meta file)', async () => {
    const home = await makeTempHome('blobs-meta-');
    const blobs = createBlobStore({ home });
    const normalizer = blobs.put(PNG, 'application/octet-stream');
    const upload = blobs.put(PNG, 'image/png', 'shot.png', { width: 4, height: 3 });
    expect(upload).toMatchObject({
      blobId: normalizer.blobId,
      mediaType: 'image/png',
      name: 'shot.png',
      width: 4,
    });
    expect((await blobs.get(upload.blobId))?.ref).toEqual(upload);
    await blobs.flush();
    expect(await readMeta(home, upload.blobId)).toEqual(upload);
    expect((await blobs.get(upload.blobId))?.ref).toEqual(upload);
    await blobs.close();
  });

  it('an upload (with pixel size) refreshes name and size of the same type – the latest upload wins', async () => {
    const home = await makeTempHome('blobs-meta-');
    const blobs = createBlobStore({ home });
    blobs.put(PNG, 'image/png', 'first.png', { width: 4, height: 3 });
    const second = blobs.put(PNG, 'image/png', 'second.png', { width: 4, height: 3 });
    expect(second.name).toBe('second.png');
    // The same meta again changes nothing.
    expect(blobs.put(PNG, 'image/png', 'second.png', { width: 4, height: 3 })).toBe(second);
    await blobs.flush();
    expect(await readMeta(home, second.blobId)).toEqual(second);
    await blobs.close();
  });

  it('a put without a pixel size or with an unconfirmed type never replaces (normalizer after an upload)', async () => {
    const home = await makeTempHome('blobs-meta-');
    const blobs = createBlobStore({ home });
    const upload = blobs.put(PNG, 'image/png', 'shot.png', { width: 4, height: 3 });
    expect(blobs.put(PNG, 'image/png')).toBe(upload);
    expect(blobs.put(PNG, 'application/octet-stream', 'x.bin')).toBe(upload);
    expect(blobs.put(PNG, 'image/jpeg', 'wrong.jpg', { width: 4, height: 3 })).toBe(upload);
    await blobs.flush();
    expect(await readMeta(home, upload.blobId)).toEqual(upload);
    await blobs.close();
  });

  it('after a restart the same rules apply against the meta file; a kept meta answers later puts', async () => {
    const home = await makeTempHome('blobs-meta-');
    const first = createBlobStore({ home });
    const upload = first.put(PNG, 'image/png', 'shot.png', { width: 4, height: 3 });
    await first.close();
    const second = createBlobStore({ home });
    // A normalizer put after the restart does not overwrite the upload's meta …
    second.put(PNG, 'application/octet-stream');
    await second.flush();
    expect(await readMeta(home, upload.blobId)).toEqual(upload);
    // … and the next put of this process answers the meta on disk.
    expect(second.put(PNG, 'image/png')).toEqual(upload);
    // A later upload with another name replaces it.
    const renamed = second.put(PNG, 'image/png', 'renamed.png', { width: 4, height: 3 });
    await second.flush();
    expect(await readMeta(home, upload.blobId)).toEqual(renamed);
    await second.close();
  });
});
