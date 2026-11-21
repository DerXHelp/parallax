import { createElement, lazy, memo, Suspense } from 'react';
import type { FeatureSlots } from '@web/shell/slots';

/**
 * Feature `changes` (WP-113): the slot `ChangesPanel` (side panel tab "Changes" – session diff, review
 * comments, git bar). A lazy chunk – nothing of the panel is imported here, so none of it reaches the
 * start chunk (its texts, namespace `changes`, are registered eagerly by WP-110). The coordinator
 * wires it in App.tsx (`ChangesPanel: bounded(CHANGES_SLOTS.ChangesPanel, bySessionKey)`); tests import
 * `ChangesPanel` directly.
 */

const LazyChangesPanel = lazy(() => import('./ChangesPanel'));

/** No fallback: the tab is empty for the moment the chunk loads (no layout jump). */
const ChangesPanelSlot = memo(function ChangesPanelSlot(props: { sessionKey: string }) {
  return createElement(Suspense, { fallback: null }, createElement(LazyChangesPanel, props));
});

export const CHANGES_SLOTS: Pick<FeatureSlots, 'ChangesPanel'> = {
  ChangesPanel: ChangesPanelSlot,
};
