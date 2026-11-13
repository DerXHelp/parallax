import { useT } from '@web/i18n';
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/ui/dialog';
import { KbdGroup } from '@web/ui/kbd';
import { shortcutKeyLabels, useShortcutList } from './shortcuts';

/**
 * The content of the `?` help (every registered shortcut; `allowInInputs` marked "also in text
 * fields"). A lazy chunk (WP-70, start-chunk budget): `ShortcutHelp` (start chunk) keeps the open
 * state, the `?` shortcut and the focus return and loads it on the first open.
 */
export function ShortcutHelpContent({ returnFocus }: { returnFocus: (event: Event) => void }) {
  const t = useT();
  const list = useShortcutList();
  return (
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
  );
}
