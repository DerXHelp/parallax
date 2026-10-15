/**
 * Process exit codes of `dist/server.js` that the launcher tells apart (WP-20 sets them in main.ts).
 * 3 is STORE_VERSION_TOO_NEW (ADR-020, store/jsonStore.ts); 4 and 5 are new here. After 4/5 the
 * launcher looks again for a running server (two starts at once: the loser opens a window of the
 * winner). Every other non-zero code is "the server stopped right after the start".
 */
import { STORE_VERSION_TOO_NEW_EXIT_CODE } from '../store/jsonStore';

export const SERVER_EXIT_CODES = {
  ok: 0,
  failure: 1,
  /** A store file has a newer `schemaVersion` → "update Parallax" (files stay unchanged). */
  storeVersionTooNew: STORE_VERSION_TOO_NEW_EXIT_CODE,
  /** `listen` → EADDRINUSE (port taken by another program or another Parallax). */
  portInUse: 4,
  /**
   * Optional pre-check of the server before opening the stores: `findRunningServer({ home })`
   * reports a live server on the same PARALLAX_HOME → exit instead of a second writer.
   */
  alreadyRunning: 5,
} as const;
