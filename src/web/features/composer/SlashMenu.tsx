import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { Badge } from '@web/ui/badge';
import { CommandList } from '@web/ui/command-list';
import type { MenuEntry } from './lib/slash';

/** DOM id of the menu list of a composer (the field's `aria-controls`). */
export function slashMenuId(inputId: string): string {
  return `${inputId}-slash`;
}

/** Kind badge of an entry (never color only: always text). */
export function KindBadge({ entry }: { entry: MenuEntry }) {
  const t = useT();
  if (entry.kind === 'plain') return null;
  return (
    <Badge variant={entry.kind === 'native' ? 'info' : 'outline'} className="shrink-0">
      {t(`composer.slash.kinds.${entry.kind}`)}
    </Badge>
  );
}

/**
 * The slash menu above the message field (WP-37 §1): a listbox driven from the field (the focus
 * stays there – `aria-activedescendant`); the composer filters (`filterMenu`) and handles the keys.
 * A click takes an entry like Enter.
 */
export function SlashMenu({
  id,
  entries,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: {
  id: string;
  entries: readonly MenuEntry[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (entry: MenuEntry) => void;
}) {
  const t = useT();
  return (
    <div
      data-slot="slash-menu"
      className="bg-popover text-popover-foreground absolute inset-x-0 bottom-full z-20 mb-1 rounded-md border p-1 shadow-lg"
    >
      <CommandList
        id={id}
        label={t('composer.slash.menu')}
        items={entries}
        getKey={(entry) => entry.name}
        activeIndex={activeIndex}
        onActiveIndexChange={onActiveIndexChange}
        onSelect={(entry) => {
          onSelect(entry);
        }}
        className="max-h-72"
        renderItem={(entry, { active }) => (
          <span data-command={entry.name} className="flex min-w-0 flex-1 items-center gap-2">
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="font-mono text-xs font-medium">/{entry.name}</span>
                {entry.argumentHint === '' ? null : (
                  <span className="text-muted-foreground truncate font-mono text-2xs">
                    {entry.argumentHint}
                  </span>
                )}
              </span>
              {entry.description === '' ? null : (
                <span
                  className={cn(
                    'truncate text-2xs',
                    active ? 'text-accent-foreground/80' : 'text-muted-foreground',
                  )}
                >
                  {entry.description}
                </span>
              )}
            </span>
            <KindBadge entry={entry} />
          </span>
        )}
      />
    </div>
  );
}
