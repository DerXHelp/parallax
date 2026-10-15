import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@web/lib/cn';

/** Compact buttons (default 28 px high, 13 px text); `asChild` renders the child element instead. */
export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 rounded-md text-ui font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] outline-none select-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-2 aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/75',
        outline: 'border border-input bg-transparent hover:bg-accent hover:text-accent-foreground',
        ghost: 'text-foreground/85 hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'text-brand underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-7 px-2.5',
        sm: 'h-6 rounded-sm px-2 text-xs',
        lg: 'h-8 px-3',
        icon: 'size-7',
        'icon-sm': 'size-6 rounded-sm',
        'icon-xs': 'size-5 rounded-sm [&_svg:not([class*=size-])]:size-3',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;

export interface ButtonProps extends ComponentProps<'button'>, ButtonVariantProps {
  asChild?: boolean;
}

/** `type` defaults to "button" (no accidental form submits). */
export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) return <Slot.Root data-slot="button" className={classes} {...props} />;
  return <button data-slot="button" type={type ?? 'button'} className={classes} {...props} />;
}
