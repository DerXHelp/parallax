import { describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { API_PATHS, blobPath, fileUrl } from '@shared/http';
import { SAMPLE_IDS, SAMPLE_REMOTE_HOST_ID } from '@shared/samples';
import { hostOfSession, sessionAttachmentsPath, sessionBlobUrl, sessionFileUrl } from './host-urls';

const BLOB = 'a'.repeat(64);
const LOCAL_KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
const REMOTE_KEY = makeSessionKey(SAMPLE_REMOTE_HOST_ID, SAMPLE_IDS.entry);

describe('host-urls (WP-80)', () => {
  it('resolves the computer of a session key, this computer as the fallback', () => {
    expect(hostOfSession(REMOTE_KEY)).toBe(SAMPLE_REMOTE_HOST_ID);
    expect(hostOfSession(LOCAL_KEY)).toBe(LOCAL_HOST_ID);
    expect(hostOfSession(null)).toBe(LOCAL_HOST_ID);
    expect(hostOfSession(undefined)).toBe(LOCAL_HOST_ID);
    expect(hostOfSession('not a key')).toBe(LOCAL_HOST_ID);
  });

  it('keeps the local routes for this computer', () => {
    expect(sessionBlobUrl(LOCAL_KEY, BLOB)).toBe(blobPath(BLOB));
    expect(sessionFileUrl(LOCAL_KEY, SAMPLE_IDS.entry, 'C:\\a b\\c.md')).toBe(
      fileUrl(SAMPLE_IDS.entry, 'C:\\a b\\c.md'),
    );
    expect(sessionAttachmentsPath(null)).toBe(API_PATHS.attachments);
  });

  it('uses the forwarding routes of this server for another computer (same origin)', () => {
    expect(sessionBlobUrl(REMOTE_KEY, BLOB)).toBe(`/api/hosts/${SAMPLE_REMOTE_HOST_ID}/blob/${BLOB}`);
    expect(sessionFileUrl(REMOTE_KEY, SAMPLE_IDS.entry, 'C:\\a b\\c.md')).toBe(
      `/api/hosts/${SAMPLE_REMOTE_HOST_ID}/file?entryId=${encodeURIComponent(SAMPLE_IDS.entry)}&path=${encodeURIComponent('C:\\a b\\c.md')}`,
    );
    expect(sessionAttachmentsPath(REMOTE_KEY)).toBe(`/api/hosts/${SAMPLE_REMOTE_HOST_ID}/attachments`);
  });
});
