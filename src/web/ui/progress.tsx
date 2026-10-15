import { Progress as ProgressPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@web/lib/cn';

/** Task progress (0–100). Give it an accessible name (`aria-label` via `t()`). For "level" values use `Gauge`. */
export function Progress({ className, value, ...props }: ComponentProps<typeof ProgressPrimitive.Root>) {
  const percent = Math.min(100, Math.max(0, value ?? 0));
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn('bg-muted relative h-1.5 w-full overflow-hidden rounded-full', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-brand h-full w-full flex-1 transition-transform duration-300"
        style={{ transform: `translateX(-${String(100 - percent)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
