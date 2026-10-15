import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@web/lib/cn';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible';

/**
 * A collapsible part with a chevron toggle (tool calls, thinking, inputs of a permission card):
 * the trigger is a real `<button>` with `aria-expanded` (Enter/Space toggle), the body is only
 * mounted while open. Controlled (`open` + `onOpenChange`) or uncontrolled (`defaultOpen`).
 * `actions` sit next to the toggle, never inside the button.
 */
export function Disclosure({
  open,
  defaultOpen,
  onOpenChange,
  label,
  header,
  actions,
  children,
  className,
  triggerClassName,
  contentClassName,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Accessible name of the toggle (from `t()`) when the visible header alone is not enough. */
  label?: string;
  header: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  return (
    <Collapsible open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} className={className}>
      <div className="flex min-w-0 items-center gap-1">
        <CollapsibleTrigger
          aria-label={label}
          className={cn(
            'group/disclosure hover:bg-accent/60 focus-visible:ring-ring flex min-h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 text-left outline-none focus-visible:ring-2',
            triggerClassName,
          )}
        >
          <ChevronRightIcon
            aria-hidden
            className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[state=open]/disclosure:rotate-90 motion-reduce:transition-none"
          />
          {header}
        </CollapsibleTrigger>
        {actions}
      </div>
      <CollapsibleContent className={cn('min-w-0', contentClassName)}>{children}</CollapsibleContent>
    </Collapsible>
  );
}
