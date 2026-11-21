import { createElement, lazy, memo, Suspense, useState } from 'react';
import { useShellRequestHandler } from '@web/shell/requests';
import { useShortcut } from '@web/shell/shortcuts';
import type { FeatureSlots, NoSlotProps } from '@web/shell/slots';
import { useSearchHosts } from './lib/use-content-search';

/**
 * Feature `search` (WP-115, ADR-255): the slot `SearchDialog`, mounted once by the AppShell. The eager
 * part only takes the request `search.open` and the shortcut Ctrl+Shift+F; the dialog is a lazy
 * chunk, loaded at the first opening. Without a computer that searches contents
 * (`HostState.features.search`) the request and the shortcut stay free (false → the next handler,
 * the browser). The coordinator wires it in App.tsx (`...SEARCH_SLOTS`).
 */

const LazySearchDialog = lazy(() => import('./SearchDialog'));

export const SEARCH_SHORTCUT_KEYS = 'Mod+Shift+F';

interface OpenState {
  open: boolean;
  /** Every request remounts the content (a new text from Ctrl+K replaces the old one). */
  count: number;
  text: string | null;
}

const SearchDialogSlot = memo(function SearchDialogSlot(_props: NoSlotProps) {
  const hosts = useSearchHosts();
  const available = hosts.length > 0;
  const [state, setState] = useState<OpenState | null>(null);
  const show = (text: string | null) => {
    setState((previous) => ({ open: true, count: (previous?.count ?? 0) + 1, text }));
  };

  useShellRequestHandler('search.open', (request) => {
    if (!available) return false;
    show(request.text ?? null);
    return true;
  });
  useShortcut({
    id: 'search.open',
    keys: SEARCH_SHORTCUT_KEYS,
    description: 'search.shortcut',
    allowInInputs: true,
    run: () => {
      if (!available) return false;
      show(null);
      return true;
    },
  });

  if (state === null) return null;
  return createElement(
    Suspense,
    { fallback: null },
    createElement(LazySearchDialog, {
      open: state.open,
      openCount: state.count,
      initialText: state.text,
      onOpenChange: (open: boolean) => {
        setState((previous) => (previous === null ? null : { ...previous, open }));
      },
    }),
  );
});

export const SEARCH_SLOTS: Pick<FeatureSlots, 'SearchDialog'> = {
  SearchDialog: SearchDialogSlot,
};
