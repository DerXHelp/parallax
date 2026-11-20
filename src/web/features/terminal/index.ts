import { createElement, lazy, memo, Suspense } from 'react';
import type { FeatureSlots } from '@web/shell/slots';

/**
 * Feature `terminal` (WP-99b, ADR-239): the slot `TerminalPanel` (side panel tab "Terminal"). A lazy
 * chunk with xterm.js, its CSS and the lazy namespace `i18n/` – nothing of it is imported here, so
 * none of it reaches the start chunk. The coordinator wires it in App.tsx (`...TERMINAL_SLOTS`);
 * tests import `TerminalPanel` directly.
 */

const LazyTerminalPanel = lazy(() => import('./TerminalPanel'));

/** No fallback: the tab is empty for the moment the chunk loads (no layout jump). */
const TerminalPanelSlot = memo(function TerminalPanelSlot(props: { sessionKey: string }) {
  return createElement(Suspense, { fallback: null }, createElement(LazyTerminalPanel, props));
});

export const TERMINAL_SLOTS: Pick<FeatureSlots, 'TerminalPanel'> = {
  TerminalPanel: TerminalPanelSlot,
};
