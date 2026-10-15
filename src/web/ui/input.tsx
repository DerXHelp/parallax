import type { ComponentProps } from 'react';
import { cn } from '@web/lib/cn';

/** `placeholder` and `aria-label` must come from `t()`. */
export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'border-input placeholder:text-muted-foreground selection:bg-brand/30 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-destructive/30 flex h-7 w-full min-w-0 rounded-md border bg-transparent px-2 py-1 text-ui transition-[color,box-shadow] outline-none file:inline-flex file:h-5 file:border-0 file:bg-transparent file:text-xs file:font-medium focus-visible:ring-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-2',
        className,
      )}
      {...props}
    />
  );
}
