/**
 * Review comments of a session (WP-111, ADR-254): `review.add`, `review.update`, `review.remove`,
 * `review.markSent`. Host-routed (no lifecycle gate: archived and external entries too – the comments
 * are Parallax's own); every change is published as the op `review.upsert`/`review.remove` (mirror,
 * hub, every window) and saved as the whole list through the `ReviewStore` (`store/review.ts`,
 * `entries/<id>/review.json`; without a store in memory only).
 *
 * - `review.add`: the server makes id (`rc_…`) and time; state `open`, `sentAt` null. More than
 *   LIMITS.reviewCommentsMax → VALIDATION_FAILED {field: 'comments', reason: 'limit'}.
 * - `review.update`: only the given fields; an unknown id → VALIDATION_FAILED {field: 'commentId'}; the
 *   range stays `endLine ≥ line` (VALIDATION_FAILED {field: 'endLine'}). Nothing changed → no op.
 * - `review.remove`: unknown ids are ignored (no op when none is known).
 * - `review.markSent`: state `sent`, `sentAt` = now (unknown ids ignored).
 *
 * Wiring: the session engine routes these names here itself (sessions/commands.ts). The scaffolding's
 * `createReviewCommands()` (compose.ts) answers NOT_IMPLEMENTED and is never reached – WP-117 drops it.
 */
import { isDeepStrictEqual } from 'node:util';
import { LIMITS } from '@shared/common';
import { makeError } from '@shared/errors';
import { reviewCommentSchema, type ReviewComment } from '@shared/model';
import type { CommandResult, HostCommand, HostCommandName } from '@shared/protocol';
import { CommandError, type HostCommandHandler } from '../sync/ports';
import { commandError, type EngineCore, type EntryState } from './entryState';

export const REVIEW_COMMAND_NAMES = [
  'review.add',
  'review.update',
  'review.remove',
  'review.markSent',
] as const satisfies readonly HostCommandName[];

export type ReviewCommandName = (typeof REVIEW_COMMAND_NAMES)[number];
export type ReviewCommand = Extract<HostCommand, { name: ReviewCommandName }>;

const NAMES: ReadonlySet<string> = new Set(REVIEW_COMMAND_NAMES);

export function isReviewCommand(cmd: HostCommand): cmd is ReviewCommand {
  return NAMES.has(cmd.name);
}

/** Scaffolding of compose.ts (WP-110): never reached – the engine handles the names (see the file comment). */
export function createReviewCommands(): HostCommandHandler {
  return {
    names: REVIEW_COMMAND_NAMES,
    handle: (cmd) => Promise.reject(new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }))),
  };
}

/** The engine's view for the review commands. */
export interface ReviewEngine {
  readonly core: EngineCore;
  state(entryId: string): EntryState | undefined;
}

function invalid(field: string, reason: string): CommandError {
  return commandError('VALIDATION_FAILED', { field, reason });
}

export async function handleReviewCommand(engine: ReviewEngine, cmd: ReviewCommand): Promise<unknown> {
  const s = engine.state(cmd.entryId);
  if (s === undefined || s.removed) throw commandError('ENTRY_NOT_FOUND', { entryId: cmd.entryId });
  const core = engine.core;
  const list = await s.reviewList();
  switch (cmd.name) {
    case 'review.add': {
      if (list.length >= LIMITS.reviewCommentsMax) throw invalid('comments', 'limit');
      const comment = reviewCommentSchema.parse({
        id: core.ids.newId('rc'),
        path: cmd.path,
        side: cmd.side,
        line: cmd.line,
        endLine: cmd.endLine,
        quote: cmd.quote,
        text: cmd.text,
        state: 'open',
        createdAt: core.now().toISOString(),
        sentAt: null,
      } satisfies ReviewComment);
      s.setReview([...list, comment], [{ op: 'review.upsert', comments: [comment] }]);
      return { comment } satisfies CommandResult<'review.add'>;
    }
    case 'review.update': {
      const current = list.find((c) => c.id === cmd.commentId);
      if (current === undefined) throw invalid('commentId', 'unknown');
      const next: ReviewComment = {
        ...current,
        ...(cmd.text === undefined ? {} : { text: cmd.text }),
        ...(cmd.line === undefined ? {} : { line: cmd.line }),
        ...(cmd.endLine === undefined ? {} : { endLine: cmd.endLine }),
        ...(cmd.quote === undefined ? {} : { quote: cmd.quote }),
        ...(cmd.state === undefined ? {} : { state: cmd.state }),
      };
      if (next.endLine < next.line) throw invalid('endLine', 'before_line');
      const comment = reviewCommentSchema.parse(next);
      if (!isDeepStrictEqual(comment, current)) {
        s.setReview(
          list.map((c) => (c.id === comment.id ? comment : c)),
          [{ op: 'review.upsert', comments: [comment] }],
        );
      }
      return { comment } satisfies CommandResult<'review.update'>;
    }
    case 'review.remove': {
      const ids = new Set(cmd.commentIds);
      const removed = list.filter((c) => ids.has(c.id)).map((c) => c.id);
      if (removed.length > 0) {
        s.setReview(
          list.filter((c) => !ids.has(c.id)),
          [{ op: 'review.remove', commentIds: removed }],
        );
      }
      return {} satisfies CommandResult<'review.remove'>;
    }
    case 'review.markSent': {
      const ids = new Set(cmd.commentIds);
      const at = core.now().toISOString();
      const changed: ReviewComment[] = [];
      const next = list.map((c) => {
        if (!ids.has(c.id)) return c;
        const sent: ReviewComment = { ...c, state: 'sent', sentAt: at };
        changed.push(sent);
        return sent;
      });
      if (changed.length > 0) s.setReview(next, [{ op: 'review.upsert', comments: changed }]);
      return {} satisfies CommandResult<'review.markSent'>;
    }
  }
}
