import type { EntryId } from '@shared/common';
import { SESSION_HASH_PARAM } from '@shared/http';
import { isClaudeSessionUrl } from '@shared/model';

/**
 * "Open in new window" (ADR-116, Plan "Layout"): another app window on the same server that shows
 * one session. A bare entry id in `#session=` means the local host (state/selection.ts).
 */

/** `<origin>/#session=<entryId>`. */
export function sessionWindowUrl(origin: string, entryId: EntryId): string {
  return `${origin}/#${SESSION_HASH_PARAM}=${entryId}`;
}

/**
 * Opens the session in a new popup window WITHOUT opener: the new window gets its own client id
 * (R3-15, no duplicate toasts); the auth cookie applies (same profile). Only from a user action.
 */
export function openSessionWindow(entryId: EntryId): void {
  window.open(sessionWindowUrl(window.location.origin, entryId), '_blank', 'popup,noopener');
}

/**
 * WP-64 "Open in the Claude app": a Remote Control link in a new tab, without opener and referrer.
 * Only `https://claude.ai/…` (`isClaudeSessionUrl`) – anything else is never opened (false).
 * Only from a user action.
 */
export function openClaudeSessionUrl(url: string): boolean {
  if (!isClaudeSessionUrl(url)) return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}
