import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@web/lib/cn';

export const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border px-1.5 py-px text-2xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground border-transparent',
        secondary: 'bg-secondary text-secondary-foreground border-transparent',
        outline: 'text-muted-foreground border-border',
        destructive: 'border-destructive/40 text-destructive bg-destructive/10',
        success: 'border-success/40 text-success bg-success/10',
        warning: 'border-warning/40 text-warning bg-warning/10',
        info: 'border-info/40 text-info bg-info/10',
      },
    },
    defaultVariants: { variant: 'secondary' },
  },
);

export interface BadgeProps extends ComponentProps<'span'>, VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

/** Small label; color variants always come with text (never color only). */
export function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  const classes = cn(badgeVariants({ variant }), className);
  if (asChild) return <Slot.Root data-slot="badge" className={classes} {...props} />;
  return <span data-slot="badge" className={classes} {...props} />;
}
