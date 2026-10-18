import { KeyboardIcon } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { useT } from '@web/i18n';
import { HELP_KEYS, openShortcutHelp } from '@web/shell/ShortcutHelp';
import { Button } from '@web/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/ui/dialog';
import { Kbd } from '@web/ui/kbd';
import type { MenuEntry, MenuKind } from './lib/slash';

const GROUPS: readonly MenuKind[] = ['native', 'builtin', 'custom', 'mcp', 'plain'];

/**
 * `/help` (WP-37 §2): the native commands and the catalog of Claude Code, grouped by origin, with
 * argument hints and aliases; the terminal-only commands as one line; a link to the keyboard
 * shortcuts (`?`, ShortcutHelp of the shell). Opened only by the user. Without a trigger (it opens
 * from the composer) it gives the focus back itself (V3-04): to the element focused when it opened,
 * else `returnFocus` (the message field) – not when it hands over to the shortcut help.
 */
export function HelpDialog({
  open,
  onOpenChange,
  entries,
  terminal,
  hasCatalog,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: readonly MenuEntry[];
  terminal: readonly string[];
  hasCatalog: boolean;
  /** Focus target after closing when the element that had the focus is gone. */
  returnFocus: () => void;
}) {
  const t = useT();
  const openerRef = useRef<HTMLElement | null>(null);
  const toShortcutsRef = useRef(false);
  // A layout effect: it runs before the dialog moves the focus into itself.
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    toShortcutsRef.current = false;
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="slash-help"
        className="sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          // Radix would focus the (missing) trigger, i.e. nothing: the focus fell to <body>.
          event.preventDefault();
          if (toShortcutsRef.current) return;
          const opener = openerRef.current;
          if (opener?.isConnected === true) opener.focus();
          else returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('composer.help.title')}</DialogTitle>
          <DialogDescription>{t('composer.help.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {GROUPS.map((kind) => {
            const group = entries.filter((entry) => entry.kind === kind);
            if (group.length === 0) return null;
            return (
              <section key={kind} className="grid gap-1">
                <h3 className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">
                  {t(`composer.help.${kind}`)}
                </h3>
                {/* One column grid for all rows (subgrid): the descriptions line up; long names
                    and argument hints wrap inside the first column. */}
                <dl className="divide-border grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)] gap-x-3 divide-y text-xs">
                  {group.map((entry) => (
                    <div key={entry.name} className="col-span-2 grid grid-cols-subgrid py-1">
                      <dt className="min-w-0 font-mono wrap-anywhere">
                        <span className="font-medium">/{entry.name}</span>
                        {entry.argumentHint === '' ? null : (
                          <span className="text-muted-foreground block text-2xs">{entry.argumentHint}</span>
                        )}
                      </dt>
                      <dd className="text-muted-foreground min-w-0 break-words">
                        {entry.description}
                        {entry.aliases.length === 0 ? null : (
                          <span className="block text-2xs">
                            {t('composer.help.aliases', {
                              aliases: entry.aliases.map((alias) => `/${alias}`).join(', '),
                            })}
                          </span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
          {hasCatalog ? null : (
            <p className="text-muted-foreground text-2xs">{t('composer.help.noCatalog')}</p>
          )}
          {terminal.length === 0 ? null : (
            <p className="text-muted-foreground text-2xs">
              {t('composer.help.terminal', { commands: terminal.map((name) => `/${name}`).join(', ') })}
            </p>
          )}
        </div>
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            data-action="shortcut-help"
            onClick={() => {
              // The shortcut help opens and takes the focus.
              toShortcutsRef.current = true;
              onOpenChange(false);
              openShortcutHelp();
            }}
          >
            <KeyboardIcon aria-hidden />
            {t('composer.help.shortcuts')}
            <Kbd>{HELP_KEYS}</Kbd>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
