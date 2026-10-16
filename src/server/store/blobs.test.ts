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

  it('the first ref of a content wins (a second upload with another size answers the first)', async () => {
    const home = await makeTempHome('blobs-size-');
    const blobs = createBlobStore({ home });
    const first = blobs.put('same', 'image/png', 'first.png', { width: 10, height: 10 });
    expect(blobs.put('same', 'image/png', 'second.png', { width: 20, height: 20 })).toEqual(first);
    await blobs.close();
  });
});
