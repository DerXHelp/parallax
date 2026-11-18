/**
 * Header rules of the remote-access listener (docs/wp/WP-76.md §B.6): browser requests are refused
 * (defence in depth – the other computer is never a browser), and the controlling computer sends
 * its Parallax and protocol version with every request (REMOTE_HEADERS).
 */
import type { IncomingHttpHeaders } from 'node:http';
import { REMOTE_HEADERS } from '@shared/http';
import { appVersionSchema } from '@shared/model';
import { PROTOCOL_VERSION } from '@shared/protocol';

/** `Origin`, any `Sec-Fetch-*` or `Cookie` → a browser (or something posing as one). */
export function hasBrowserHeaders(headers: IncomingHttpHeaders): boolean {
  if (headers.origin !== undefined || headers.cookie !== undefined) return true;
  return Object.keys(headers).some((name) => name.toLowerCase().startsWith('sec-fetch-'));
}

/** The sent version (if well-formed) and whether version and protocol both equal this server's. */
export function remoteVersionOf(
  headers: IncomingHttpHeaders,
  appVersion: string,
): { version: string | null; compatible: boolean } {
  const version = headers[REMOTE_HEADERS.version];
  const protocol = headers[REMOTE_HEADERS.protocol];
  const sent = typeof version === 'string' && appVersionSchema.safeParse(version).success ? version : null;
  return { version: sent, compatible: sent === appVersion && protocol === String(PROTOCOL_VERSION) };
}

/** Path of a request URL without query or fragment. */
export function pathOf(url: string | undefined): string {
  const value = url ?? '';
  const end = value.search(/[?#]/u);
  return end < 0 ? value : value.slice(0, end);
}
