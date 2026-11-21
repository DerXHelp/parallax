import { useEffect, useRef } from 'react';
import type { ReviewComment } from '@shared/model';
import { useSessionSelector } from '@web/state/hooks';
import { anchorUpdate, type Placement } from '../lib/anchor';
import { updateReviewComment } from './git';

/**
 * Review comments of the session (ADR-254): `SessionDetail.review`, kept by the ops `review.upsert`
 * and `review.remove` in every window. The window re-anchors them in the complete session diff and
 * tells the server (`review.update`) when a comment moved, went stale or came back.
 */

const NO_COMMENTS: readonly ReviewComment[] = Object.freeze([]);

export function useReviewComments(sessionKey: string): readonly ReviewComment[] {
  return useSessionSelector(sessionKey, (view) => view.detail.review, NO_COMMENTS);
}

/**
 * Sends the anchor updates of one file's comments while its diff is `authoritative` (scope `session`,
 * patch loaded and not cut off). Each comment is checked once per loaded patch (`patchAt`), and only
 * when it is older than that patch: two windows holding different versions of the diff would
 * otherwise mark the same comment stale and open again in turns. The next load (turn end, refresh)
 * checks again; a failed update may be sent with it.
 */
export function useReanchor(
  sessionKey: string,
  comments: readonly ReviewComment[],
  placements: ReadonlyMap<ReviewComment['id'], Placement | null>,
  authoritative: boolean,
  patchAt: number | null,
): void {
  const checked = useRef<{ patchAt: number | null; ids: Set<string> }>({ patchAt: null, ids: new Set() });
  useEffect(() => {
    if (!authoritative || patchAt === null) return;
    if (checked.current.patchAt !== patchAt) checked.current = { patchAt, ids: new Set() };
    const { ids } = checked.current;
    for (const comment of comments) {
      const placement = placements.get(comment.id);
      if (placement === undefined || ids.has(comment.id)) continue;
      // Made from a newer diff than this one (another window): the next load decides.
      if (Date.parse(comment.createdAt) > patchAt) continue;
      ids.add(comment.id);
      const change = anchorUpdate(comment, placement);
      if (change === null) continue;
      updateReviewComment(sessionKey, comment.id, change).catch(() => {
        ids.delete(comment.id);
      });
    }
  }, [authoritative, comments, placements, patchAt, sessionKey]);
}
