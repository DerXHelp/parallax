import { FileIcon } from 'lucide-react';
import type { ErrorPayload } from '@shared/errors';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { CommandList } from '@web/ui/command-list';
import { Spinner } from '@web/ui/spinner';
import { splitPath, type PathIndex } from './lib/mentions';

/** DOM id of the @ list of a composer (the field's `aria-controls`). */
export function mentionMenuId(inputId: string): string {
  return `${inputId}-mention`;
}

/** The project files of one opening of the picker. */
export type ProjectFilesState =
  | { status: 'loading' }
  | { status: 'ready'; index: PathIndex; truncated: boolean }
  | { status: 'error'; error: ErrorPayload };

/**
 * The @ file picker above the message field (ADR-151, WP-57): like the slash menu a listbox driven
 * from the field (the focus stays there – `aria-activedescendant`); the composer filters and
 * handles the keys. A row shows the file name and its folder; a status line says "loading", the
 * error, "no match", that only the first matches are shown or that the project list was cut.
 */
export function FileMentionMenu({
  id,
  state,
  matches,
  total,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: {
  id: string;
  state: ProjectFilesState;
  matches: readonly string[];
  /** Matches before the cut to `MENTION_MATCHES_MAX`. */
  total: number;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (path: string) => void;
}) {
  const { t, tError } = useI18n();
  const notes: string[] = [];
  if (state.status === 'ready') {
    if (matches.length === 0) {
      notes.push(
        state.index.paths.length === 0 ? t('composer.mention.noFiles') : t('composer.mention.empty'),
      );
    } else if (total > matches.length) {
      // With the "list cut" note below, the count goes without a second "keep typing".
      const key = state.truncated ? 'composer.mention.moreShort' : 'composer.mention.more';
      notes.push(t(key, { shown: matches.length, total }));
    }
    if (state.truncated) notes.push(t('composer.mention.truncated'));
  }
  return (
    <div
      data-slot="mention-menu"
      data-state={state.status}
      className="bg-popover text-popover-foreground absolute inset-x-0 bottom-full z-20 mb-1 rounded-md border p-1 shadow-lg"
    >
      <CommandList
        id={id}
        label={t('composer.mention.list')}
        items={matches}
        getKey={(path) => path}
        activeIndex={activeIndex}
        onActiveIndexChange={onActiveIndexChange}
        onSelect={(path) => {
          onSelect(path);
        }}
        className="max-h-72"
        renderItem={(path, { active }) => {
          const { name, folder } = splitPath(path);
          return (
            <span data-path={path} className="flex min-w-0 flex-1 items-center gap-2">
              <FileIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
              <span className="shrink-0 font-mono text-xs font-medium">{name}</span>
              {folder === '' ? null : (
                <span
                  className={cn(
                    'min-w-0 truncate font-mono text-2xs',
                    active ? 'text-accent-foreground/80' : 'text-muted-foreground',
                  )}
                >
                  {folder}
                </span>
              )}
            </span>
          );
        }}
      />
      <div role="status" data-slot="mention-status" className="grid gap-0.5 empty:hidden">
        {state.status === 'loading' ? (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 px-2 py-1.5 text-2xs">
            <Spinner className="size-3" />
            {t('composer.mention.loading')}
          </span>
        ) : null}
        {state.status === 'error' ? (
          <span className="text-destructive flex flex-wrap gap-x-1 px-2 py-1.5 text-2xs">
            <span>{t('composer.mention.failed')}</span>
            <span>{tError(state.error)}</span>
          </span>
        ) : null}
        {notes.map((note) => (
          <span key={note} className="text-muted-foreground px-2 py-1 text-2xs">
            {note}
          </span>
        ))}
      </div>
    </div>
  );
}
