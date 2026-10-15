import type { ComponentProps } from 'react';
import { cn } from '@web/lib/cn';

/** Auto-growing (`field-sizing: content`, capped by `max-h-*` from the caller). */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'border-input placeholder:text-muted-foreground focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-destructive/30 flex field-sizing-content min-h-14 w-full rounded-md border bg-transparent px-2 py-1.5 text-ui transition-[color,box-shadow] outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-2',
        className,
      )}
      {...props}
    />
  );
}
