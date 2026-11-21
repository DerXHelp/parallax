import { createElement, lazy, memo, Suspense, useState } from 'react';
import { useShellRequestHandler } from '@web/shell/requests';
import type { FeatureSlots, NoSlotProps } from '@web/shell/slots';
import { useSummarySelector } from '@web/state/hooks';
import { clientStore } from '@web/state/store';
import { wantsCleanup } from './lib/cleanup';

/**
 * Feature `worktrees` (WP-114, ADR-250/251): the slots `WorktreeNotice` (below the pane banners) and
 * `WorktreeCleanup` (window-wide, request `worktree.cleanup`). Both bodies are lazy chunks: the notice
 * loads only while a session has a setup state (`SessionSummary.worktreeSetup`), the dialog only when
 * the request comes. The request handler itself is part of the slot, so the shell menus can ask any
 * time: it takes the request only for a session with a worktree on a host with the git service –
 * otherwise the caller goes on without (archive/remove as before). The coordinator wires
 * `...WORKTREE_SLOTS` in App.tsx; tests import the modules directly.
 */

const LazyWorktreeNotice = lazy(() => import('./WorktreeNotice'));
const LazyWorktreeCleanup = lazy(() => import('./WorktreeCleanup'));

const WorktreeNoticeSlot = memo(function WorktreeNoticeSlot(props: { sessionKey: string }) {
  const active = useSummarySelector(props.sessionKey, (summary) => summary.worktreeSetup !== null, false);
  if (!active) return null;
  return createElement(Suspense, { fallback: null }, createElement(LazyWorktreeNotice, props));
});

interface CleanupTarget {
  sessionKey: string;
  then: 'archive' | 'remove';
  /** New per request: the dialog starts fresh. */
  opening: number;
}

/** Takes `worktree.cleanup` while mounted and shows the dialog for it. */
export const WorktreeCleanupSlot = memo(function WorktreeCleanupSlot(_props: NoSlotProps) {
  const [target, setTarget] = useState<CleanupTarget | null>(null);
  useShellRequestHandler('worktree.cleanup', (request) => {
    if (!wantsCleanup(clientStore.getState(), request.sessionKey)) return false;
    setTarget((previous) => ({
      sessionKey: request.sessionKey,
      then: request.then,
      opening: (previous?.opening ?? 0) + 1,
    }));
    return true;
  });
  if (target === null) return null;
  return createElement(
    Suspense,
    { fallback: null },
    createElement(LazyWorktreeCleanup, {
      key: target.opening,
      sessionKey: target.sessionKey,
      then: target.then,
      onClose: () => {
        setTarget(null);
      },
    }),
  );
});

export const WORKTREE_SLOTS: Pick<FeatureSlots, 'WorktreeNotice' | 'WorktreeCleanup'> = {
  WorktreeNotice: WorktreeNoticeSlot,
  WorktreeCleanup: WorktreeCleanupSlot,
};
