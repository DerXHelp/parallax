import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { UPDATE_PACKAGE_MAX_BYTES } from '@shared/http';
import {
  changelogUrl,
  fetchChangelog,
  fetchNotices,
  noticesUrl,
  updateHttpErrorOf,
  uploadUpdatePackage,
} from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(answer: () => Response | Promise<Response>) {
  const mock = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(answer()));
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (caught) {
    return updateHttpErrorOf(caught);
  }
  throw new Error('expected a failure');
}

const signal = new AbortController().signal;

describe('update HTTP (WP-87 §1.4)', () => {
  it('builds the changelog and notices URLs', () => {
    expect(changelogUrl({ for: 'available' })).toBe('/api/changelog?for=available');
    expect(changelogUrl({ for: 'installed', since: '1.0.0-rc.4' })).toBe(
      '/api/changelog?for=installed&since=1.0.0-rc.4',
    );
    expect(noticesUrl('third-party')).toBe('/api/notices?file=third-party');
  });

  it('GETs the changelog with the cookie and parses the answer', async () => {
    const answer = {
      version: '1.0.1',
      sections: [{ version: '1.0.1', date: '2026-11-20', body: '- Faster' }],
    };
    const mock = stubFetch(() => json(answer));
    await expect(fetchChangelog({ for: 'available' }, signal)).resolves.toEqual(answer);
    expect(mock).toHaveBeenCalledWith(
      '/api/changelog?for=available',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', signal }),
    );
  });

  it('turns an error answer into its payload, else a code from the status', async () => {
    stubFetch(() => json(makeError('FILE_NOT_FOUND'), 404));
    expect((await failure(fetchNotices('license', signal))).code).toBe('FILE_NOT_FOUND');
    stubFetch(() => new Response('gone', { status: 404 }));
    expect((await failure(fetchNotices('license', signal))).code).toBe('FILE_NOT_FOUND');
    stubFetch(() => new Response('', { status: 500 }));
    expect(await failure(fetchNotices('license', signal))).toEqual(
      makeError('INTERNAL_ERROR', { status: 500 }),
    );
  });

  it('rejects an answer that does not match its schema; a failed request is CONNECTION_LOST', async () => {
    stubFetch(() => json({ file: 'license' }));
    expect((await failure(fetchNotices('license', signal))).code).toBe('INVALID_MESSAGE');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect((await failure(fetchChangelog({ for: 'installed' }, signal))).code).toBe('CONNECTION_LOST');
  });

  it('POSTs the zip as application/zip and expects 202 {accepted: true}', async () => {
    const mock = stubFetch(() => json({ accepted: true }, 202));
    const file = new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'parallax-1.0.1-win.zip', {
      type: 'application/x-zip-compressed',
    });
    await uploadUpdatePackage(file);
    expect(mock).toHaveBeenCalledWith('/api/update/package', {
      credentials: 'same-origin',
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/zip' },
    });
  });

  it('a too large package fails before sending; a refusal carries the server payload', async () => {
    const mock = stubFetch(() => json(makeError('UPDATE_BUSY', { status: 'preparing' }), 409));
    const big = new Blob(['zip']);
    Object.defineProperty(big, 'size', { value: UPDATE_PACKAGE_MAX_BYTES + 1 });
    expect((await failure(uploadUpdatePackage(big))).code).toBe('PAYLOAD_TOO_LARGE');
    expect(mock).not.toHaveBeenCalled();
    expect(await failure(uploadUpdatePackage(new Blob(['zip'])))).toEqual(
      makeError('UPDATE_BUSY', { status: 'preparing' }),
    );
  });
});
