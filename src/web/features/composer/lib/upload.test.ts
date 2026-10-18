import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { API_PATHS } from '@shared/http';
import { sampleBlobRef } from '@shared/samples';
import type { PreparedImage } from './images';
import { httpUploader, UploadError, uploadQuery } from './upload';

const IMAGE: PreparedImage = {
  blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
  type: 'image/png',
  name: 'Bildschirmfoto 1.png',
  width: 1568,
  height: 882,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('httpUploader (ADR-103, WP-33 route)', () => {
  it('posts the raw bytes with type, name and size and parses the blob ref', async () => {
    const ref = sampleBlobRef({ name: IMAGE.name, width: 1568, height: 882 });
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(json(200, { attachment: ref })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await httpUploader(IMAGE, new AbortController().signal);
    expect(result).toEqual(ref);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe(`${API_PATHS.attachments}?name=Bildschirmfoto+1.png&width=1568&height=882`);
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      body: IMAGE.blob,
      headers: { 'Content-Type': 'image/png' },
      credentials: 'same-origin',
    });
    expect(uploadQuery({ ...IMAGE, name: 'x'.repeat(300) })).toContain(`name=${'x'.repeat(260)}&`);
  });

  it.each([
    [413, makeError('PAYLOAD_TOO_LARGE')],
    [415, makeError('UNSUPPORTED_MEDIA_TYPE')],
  ])('HTTP %i → the server error payload', async (status, payload) => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(status, payload)));
    await expect(httpUploader(IMAGE, new AbortController().signal)).rejects.toEqual(new UploadError(payload));
  });

  it('without a payload the status decides; a failed request is CONNECTION_LOST', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 413 })));
    await expect(httpUploader(IMAGE, new AbortController().signal)).rejects.toMatchObject({
      payload: { code: 'PAYLOAD_TOO_LARGE' },
    });
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(httpUploader(IMAGE, new AbortController().signal)).rejects.toMatchObject({
      payload: { code: 'CONNECTION_LOST' },
    });
    vi.stubGlobal('fetch', () => Promise.resolve(json(200, { attachment: { blobId: 'nope' } })));
    await expect(httpUploader(IMAGE, new AbortController().signal)).rejects.toMatchObject({
      payload: { code: 'INVALID_MESSAGE' },
    });
  });
});
