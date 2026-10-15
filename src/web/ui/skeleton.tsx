import type { ComponentProps } from 'react';
import { cn } from '@web/lib/cn';

/** Loading placeholder (decorative: the surrounding region carries `aria-busy`). */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn('bg-muted motion-safe:animate-pulse rounded-md', className)}
      {...props}
    />
  );
}
