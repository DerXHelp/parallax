import { lazy, Suspense, useSyncExternalStore } from 'react';
import { useReturnFocus } from '@web/lib/return-focus';
import { Dialog } from '@web/ui/dialog';
import { useShortcut } from './shortcuts';

/** WP-70: the list is a lazy chunk – needed only once the help opens (start-chunk budget). */
const ShortcutHelpContent = lazy(() =>
  import('./ShortcutHelpContent').then((module) => ({ default: module.ShortcutHelpContent })),
);

/** Keys of the help shortcut. */
export const HELP_KEYS = '?';

let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of [...listeners]) listener();
}

/** Opens the shortcut help (settings menu, `?`). */
export function openShortcutHelp(): void {
  setOpen(true);
}

/** Closes it (tests: the open state is module-wide and would survive an unmount). */
export function closeShortcutHelp(): void {
  setOpen(false);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getOpen(): boolean {
  return open;
}

/**
 * `?` help listing every registered shortcut (Plan B "zentrale Shortcut-Registry mit ?-Hilfe");
 * shortcuts with `allowInInputs` are marked "also in text fields".
 */
export function ShortcutHelp() {
  const isOpen = useSyncExternalStore(subscribe, getOpen, getOpen);
  // No trigger button (`?` or a menu): the focus goes back to where it was (V3-04).
  const returnFocus = useReturnFocus(isOpen);
  useShortcut({
    id: 'shell.help',
    keys: HELP_KEYS,
    description: 'shell.shortcuts.help',
    run: () => {
      setOpen(true);
      return true;
    },
  });
  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {isOpen ? (
        <Suspense fallback={null}>
          <ShortcutHelpContent returnFocus={returnFocus} />
        </Suspense>
      ) : null}
    </Dialog>
  );
}
