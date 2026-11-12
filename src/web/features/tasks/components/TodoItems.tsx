import { CircleCheckIcon, CircleDashedIcon, LoaderCircleIcon } from 'lucide-react';
import type { TodoItem } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';

/** The todo list with a status icon per item (task strip expanded, panel section). */
export function TodoItems({ items, className }: { items: readonly TodoItem[]; className?: string }) {
  const t = useT();
  return (
    <ul data-slot="todo-items" className={cn('grid gap-1 text-xs', className)}>
      {items.map((item) => {
        const Icon =
          item.status === 'completed'
            ? CircleCheckIcon
            : item.status === 'in_progress'
              ? LoaderCircleIcon
              : CircleDashedIcon;
        return (
          <li key={item.id} data-status={item.status} className="flex min-w-0 items-start gap-1.5">
            <Icon
              aria-hidden
              className={cn(
                'mt-px size-3.5 shrink-0',
                item.status === 'completed'
                  ? 'text-success'
                  : item.status === 'in_progress'
                    ? 'text-info motion-safe:animate-spin'
                    : 'text-muted-foreground',
              )}
            />
            <span className="sr-only">{t(`tasks.todo.${item.status}`)}</span>
            <span
              className={cn(
                'min-w-0 break-words',
                item.status === 'completed' && 'text-muted-foreground line-through',
                item.status === 'in_progress' && 'font-medium',
              )}
            >
              {item.status === 'in_progress' ? (item.activeForm ?? item.content) : item.content}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
