import { LOCAL_HOST_ID, parseSessionKey, type BlobId, type EntryId, type HostId } from '@shared/common';
import { hostAttachmentsPath, hostBlobPath, hostFileUrl } from '@shared/http';

/**
 * Content URLs per computer (WP-80, WP-75 §4.4, ADR-205): blobs, files and uploads of a session
 * live on the session's computer. This computer uses the local routes (`API_PATHS`), another one
 * the forwarding routes of this server (`HOST_API_PATHS`) – always the same origin, so `<img>`,
 * `<iframe>` and `fetch` keep the cookie and the CSP `'self'`. Built only from `@shared/http`.
 */

/** Computer of a session key; this computer for null, undefined or an invalid key. */
export function hostOfSession(sessionKey: string | null | undefined): HostId {
  if (sessionKey === null || sessionKey === undefined) return LOCAL_HOST_ID;
  return parseSessionKey(sessionKey)?.hostId ?? LOCAL_HOST_ID;
}

/** `GET` URL of a blob (image, full text of a capped value) of the session's computer. */
export function sessionBlobUrl(sessionKey: string | null | undefined, blobId: BlobId): string {
  return hostBlobPath(hostOfSession(sessionKey), blobId);
}

/** `GET` URL of a file (viewer, plan file) of the session's computer. */
export function sessionFileUrl(
  sessionKey: string | null | undefined,
  entryId: EntryId,
  path: string,
): string {
  return hostFileUrl(hostOfSession(sessionKey), entryId, path);
}

/** `POST` path of an attachment upload to the session's computer (query from `uploadQuery`). */
export function sessionAttachmentsPath(sessionKey: string | null | undefined): string {
  return hostAttachmentsPath(hostOfSession(sessionKey));
}
