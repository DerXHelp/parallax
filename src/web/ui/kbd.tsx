import type { ComponentProps } from 'react';
import { cn } from '@web/lib/cn';

/** One key cap. Key names are translated (`common.keys.*`) – see `shortcutKeyLabels` in shell/shortcuts.ts. */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'bg-muted text-muted-foreground border-border pointer-events-none inline-flex h-4.5 min-w-4.5 items-center justify-center gap-1 rounded-sm border px-1 font-sans text-2xs font-medium select-none',
        className,
      )}
      {...props}
    />
  );
}

/** Several key caps of one combination ("Alt" "1"). */
export function KbdGroup({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <span data-slot="kbd-group" className={cn('inline-flex items-center gap-0.5', className)}>
      {keys.map((key, index) => (
        <Kbd key={`${String(index)}-${key}`}>{key}</Kbd>
      ))}
    </span>
  );
}
