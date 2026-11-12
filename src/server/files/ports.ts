/**
 * Port: file service (Phase 3, WP-53; ADR-140 … ADR-146). Types only; frozen like src/shared.
 * Consumers: http/app.ts (GET /api/file via FileContentProvider) and the composition (WP-60: host
 * command handler, tap of SessionPublisher.publishOps). Rules (check chain, kinds, limits, programs):
 * docs/architecture.md §5.2 and §9.
 */
import type { Readable } from 'node:stream';
import type { ConversationId, EntryId } from '@shared/common';
import type { SessionOp } from '@shared/protocol';
import type { HostCommandHandler } from '../sync/ports';

/** What the file service needs about an entry (WP-60 builds it from registry, profiles and home). */
export interface FileEntryInfo {
  /** Exactly as stored. */
  cwd: string;
  /** Profile `--add-dir` values (parseProfileArgs → sdkOptions.additionalDirectories). */
  additionalDirectories: readonly string[];
  /** All conversations of the entry (backfill of the index from the transcript logs). */
  conversationIds: readonly ConversationId[];
}

export interface FileEntryLookup {
  /** null = unknown entry (→ ENTRY_NOT_FOUND). */
  entry(entryId: EntryId): FileEntryInfo | null;
}

/** One answer of GET /api/file. */
export interface FileContent {
  stream: Readable;
  /** Exact Content-Type header value. */
  mediaType: string;
  /** Bytes that will be sent (after transcoding/cutting). */
  bytes: number;
  /** Base name for Content-Disposition. */
  name: string;
  /** Header set: BLOB_CSP + X-Frame-Options DENY, or FILE_PDF_CSP + SAMEORIGIN (ADR-142). */
  policy: 'blob' | 'pdf';
}

export interface FileContentProvider {
  /** GET /api/file: the checks of file.stat plus `previewable`; throws CommandError. */
  open(entryId: EntryId, path: string): Promise<FileContent>;
}

export interface FileService extends FileContentProvider {
  /** file.stat, file.statMany, file.open, files.session, files.project, editor.detect. */
  readonly commands: HostCommandHandler;
  /** Tap of SessionPublisher.publishOps (WP-60 calls it BEFORE publishing): feeds the index. */
  observeOps(entryId: EntryId, ops: readonly SessionOp[]): void;
  /** Writes pending `files.json` changes (shutdown). */
  flush(): Promise<void>;
}
