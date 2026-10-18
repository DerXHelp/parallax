import { useSyncExternalStore } from 'react';
import { useT } from '@web/i18n';
import { useReturnFocus } from '@web/lib/return-focus';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/ui/dialog';
import { KbdGroup } from '@web/ui/kbd';
import { shortcutKeyLabels, useShortcut, useShortcutList } from './shortcuts';

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
  const t = useT();
  const isOpen = useSyncExternalStore(subscribe, getOpen, getOpen);
  const list = useShortcutList();
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
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>{t('shell.shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shell.shortcuts.description')}</DialogDescription>
        </DialogHeader>
        {list.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('shell.shortcuts.empty')}</p>
        ) : (
          <dl className="divide-border grid divide-y text-xs">
            {list.map((definition) => {
              const combo =
                definition.displayKeys ??
                (typeof definition.keys === 'string' ? definition.keys : (definition.keys[0] ?? ''));
              return (
                <div key={definition.id} className="flex items-center justify-between gap-4 py-1.5">
                  <dt className="grid gap-0.5">
                    <span>{t(definition.description)}</span>
                    {/* R2W-11: shortcuts that also fire while typing (Alt+1–9, Mod+Enter in the bar). */}
                    {definition.allowInInputs === true ? (
                      <span data-slot="shortcut-in-inputs" className="text-muted-foreground text-2xs">
                        {t('shell.shortcuts.inInputs')}
                      </span>
                    ) : null}
                  </dt>
                  <dd>
                    <KbdGroup keys={shortcutKeyLabels(combo, t)} />
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </DialogContent>
    </Dialog>
  );
}
