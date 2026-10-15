import { cva, type VariantProps } from 'class-variance-authority';
import { Toggle as TogglePrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@web/lib/cn';

export const toggleVariants = cva(
  "hover:bg-accent hover:text-accent-foreground data-[state=on]:bg-accent data-[state=on]:text-accent-foreground focus-visible:ring-ring inline-flex items-center justify-center gap-1.5 rounded-md text-ui font-medium whitespace-nowrap transition-[color,background-color,box-shadow] outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: 'bg-transparent text-muted-foreground',
        outline: 'border-input border bg-transparent text-muted-foreground',
      },
      size: {
        default: 'h-7 min-w-7 px-2',
        sm: 'h-6 min-w-6 px-1.5 text-xs',
        lg: 'h-8 min-w-8 px-2.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ToggleVariantProps = VariantProps<typeof toggleVariants>;

export function Toggle({
  className,
  variant,
  size,
  ...props
}: ComponentProps<typeof TogglePrimitive.Root> & ToggleVariantProps) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size }), className)}
      {...props}
    />
  );
}
