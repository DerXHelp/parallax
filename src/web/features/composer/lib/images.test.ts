import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@shared/common';
import {
  ENCODE_STEPS,
  fitWithin,
  ImagePrepareError,
  nameForType,
  prepareImage,
  type DecodedImage,
  type EncodeStep,
  type Size,
} from './images';

/** A decoder with the given natural size whose encoder returns blobs of `sizes[type/quality]`. */
function fakeDecoder(natural: Size, bytesFor: (step: EncodeStep) => number | null) {
  const encoded: { size: Size; step: EncodeStep }[] = [];
  const close = vi.fn();
  const decode = vi.fn((): Promise<DecodedImage> =>
    Promise.resolve({
      ...natural,
      close,
      encode: (size, step) => {
        encoded.push({ size, step });
        const bytes = bytesFor(step);
        return Promise.resolve(
          bytes === null ? null : new Blob([new Uint8Array(bytes)], { type: step.type }),
        );
      },
    }),
  );
  return { decode, encoded, close };
}

function file(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('fitWithin', () => {
  it.each([
    [
      { width: 3000, height: 2000 },
      { width: 1568, height: 1045 },
    ],
    [
      { width: 1000, height: 4000 },
      { width: 392, height: 1568 },
    ],
    [
      { width: 1568, height: 10 },
      { width: 1568, height: 10 },
    ],
    [
      { width: 800, height: 600 },
      { width: 800, height: 600 },
    ],
    [
      { width: 100_000, height: 1 },
      { width: 1568, height: 1 },
    ],
  ])('%j → %j', (size, expected) => {
    expect(fitWithin(size, LIMITS.imageMaxEdgePx)).toEqual(expected);
  });
});

describe('prepareImage (ADR-103)', () => {
  it('keeps an image that needs neither scaling nor a smaller file', async () => {
    const codec = fakeDecoder({ width: 800, height: 600 }, () => 1);
    const original = file('shot.jpg', 'image/jpeg', 5000);
    const prepared = await prepareImage(original, { decode: codec.decode });
    expect(prepared).toMatchObject({
      blob: original,
      type: 'image/jpeg',
      width: 800,
      height: 600,
      name: 'shot.jpg',
    });
    expect(codec.encoded).toEqual([]);
    expect(codec.close).toHaveBeenCalledOnce();
  });

  it('scales the long edge to the limit and encodes PNG', async () => {
    const codec = fakeDecoder({ width: 3136, height: 1000 }, () => 2_000_000);
    const prepared = await prepareImage(file('screen.png', 'image/png', 4_000_000), { decode: codec.decode });
    expect(prepared).toMatchObject({ type: 'image/png', width: 1568, height: 500, name: 'screen.png' });
    expect(codec.encoded.map((entry) => entry.step)).toEqual([ENCODE_STEPS[0]]);
    expect(codec.encoded[0]?.size).toEqual({ width: 1568, height: 500 });
  });

  it('steps down to JPEG 0.9 → 0.8 → 0.7 while the result is too large', async () => {
    const sizes: Record<string, number> = {
      png: 5_000_000,
      '0.9': 4_000_000,
      '0.8': 3_800_000,
      '0.7': 3_000_000,
    };
    const codec = fakeDecoder(
      { width: 1500, height: 1500 },
      (step) => sizes[step.quality === null ? 'png' : String(step.quality)] ?? null,
    );
    const prepared = await prepareImage(file('photo.webp', 'image/webp', 6_000_000), {
      decode: codec.decode,
    });
    expect(codec.encoded.map((entry) => [entry.step.type, entry.step.quality])).toEqual([
      ['image/png', null],
      ['image/jpeg', 0.9],
      ['image/jpeg', 0.8],
      ['image/jpeg', 0.7],
    ]);
    expect(prepared).toMatchObject({ type: 'image/jpeg', name: 'photo.jpg', width: 1500, height: 1500 });
    expect(prepared.blob.size).toBe(3_000_000);
  });

  it('fails when even JPEG 0.7 is too large (and when the browser cannot encode)', async () => {
    const tooLarge = fakeDecoder({ width: 2000, height: 2000 }, () => LIMITS.imageBytes + 1);
    await expect(
      prepareImage(file('huge.png', 'image/png', 9_000_000), { decode: tooLarge.decode }),
    ).rejects.toEqual(new ImagePrepareError('tooLarge'));
    expect(tooLarge.close).toHaveBeenCalledOnce();
    const noCanvas = fakeDecoder({ width: 2000, height: 2000 }, () => null);
    await expect(
      prepareImage(file('huge.png', 'image/png', 9_000_000), { decode: noCanvas.decode }),
    ).rejects.toMatchObject({
      problem: 'tooLarge',
    });
  });

  it('keeps a GIF that is small enough unchanged (animation), even above the edge limit', async () => {
    const codec = fakeDecoder({ width: 3000, height: 3000 }, () => 1);
    const gif = file('anim.gif', 'image/gif', 1_000_000);
    const prepared = await prepareImage(gif, { decode: codec.decode });
    expect(prepared).toMatchObject({ blob: gif, type: 'image/gif', width: 3000, height: 3000 });
    expect(codec.encoded).toEqual([]);
  });

  it('re-encodes a GIF that is too large', async () => {
    const codec = fakeDecoder({ width: 1000, height: 1000 }, () => 1_000_000);
    const prepared = await prepareImage(file('anim.gif', 'image/gif', 5_000_000), { decode: codec.decode });
    expect(prepared).toMatchObject({ type: 'image/png', name: 'anim.png' });
  });

  it('rejects other types and unreadable images', async () => {
    await expect(prepareImage(file('notes.txt', 'text/plain', 10))).rejects.toMatchObject({
      problem: 'type',
    });
    await expect(
      prepareImage(file('broken.png', 'image/png', 10), { decode: () => Promise.reject(new Error('bad')) }),
    ).rejects.toMatchObject({ problem: 'decode' });
  });
});

describe('nameForType', () => {
  it.each([
    ['image.png', 'image/jpeg', 'image.jpg'],
    ['Screenshot 2026-10-16.png', 'image/png', 'Screenshot 2026-10-16.png'],
    ['', 'image/png', 'image.png'],
    ['archive.tar.gz', 'image/webp', 'archive.tar.webp'],
    ['.hidden', 'image/gif', '.hidden.gif'],
  ] as const)('%j as %s → %j', (name, type, expected) => {
    expect(nameForType(name, type)).toBe(expected);
  });
});
