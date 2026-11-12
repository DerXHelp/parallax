import { EllipsisIcon } from 'lucide-react';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { ContextMenuItem } from '@web/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { IconButton } from '@web/ui/icon-button';
import { fileName } from '../lib/paths';
import type { FileAction } from '../lib/actions';

/** The actions of a file as items of a context menu or a dropdown (one definition: lib/actions.ts). */
export function FileActionItems({
  actions,
  kind,
}: {
  actions: readonly FileAction[];
  kind: 'context' | 'dropdown';
}) {
  const t = useT();
  return actions.map((action) => {
    const Icon = action.icon;
    const content = (
      <>
        <Icon aria-hidden />
        {t(action.label)}
      </>
    );
    return kind === 'context' ? (
      <ContextMenuItem key={action.id} data-action={action.id} onSelect={action.run}>
        {content}
      </ContextMenuItem>
    ) : (
      <DropdownMenuItem key={action.id} data-action={action.id} onSelect={action.run}>
        {content}
      </DropdownMenuItem>
    );
  });
}

/** "…" button with the actions of one file (the visible twin of the context menu). */
export function FileActionsMenu({
  path,
  actions,
  className,
  align = 'end',
}: {
  path: string;
  actions: readonly FileAction[];
  className?: string;
  align?: 'start' | 'end';
}) {
  const t = useT();
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={t('files.actions.menu', { name: fileName(path) })}
          showTooltip={false}
          data-slot="file-actions"
          className={cn('size-6', className)}
        >
          <EllipsisIcon aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        <FileActionItems actions={actions} kind="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
