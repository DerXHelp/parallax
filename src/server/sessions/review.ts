/**
 * Review comments of a session (WP-110 scaffolding; WP-111 fills it, ADR-254): `review.add`,
 * `review.update`, `review.remove`, `review.markSent`. Host-routed (no lifecycle gate, archived entries
 * too); every change is published as the op `review.upsert`/`review.remove` and saved through the
 * `ReviewStore` (`store/review.ts`, `entries/<id>/review.json`).
 *
 * Stub until WP-111: every review command answers NOT_IMPLEMENTED.
 */
import { makeError } from '@shared/errors';
import type { HostCommandName } from '@shared/protocol';
import { CommandError, type HostCommandHandler } from '../sync/ports';

export const REVIEW_COMMAND_NAMES = [
  'review.add',
  'review.update',
  'review.remove',
  'review.markSent',
] as const satisfies readonly HostCommandName[];

export function createReviewCommands(): HostCommandHandler {
  return {
    names: REVIEW_COMMAND_NAMES,
    handle: (cmd) => Promise.reject(new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }))),
  };
}
