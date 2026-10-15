import type { ComponentProps } from 'react';
import { cn } from '@web/lib/cn';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn(
        'bg-card text-card-foreground flex flex-col gap-3 rounded-lg border py-3 shadow-xs',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'grid auto-rows-min grid-rows-[auto_auto] items-start gap-0.5 px-3 has-data-[slot=card-action]:grid-cols-[1fr_auto]',
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="card-title" className={cn('text-ui leading-tight font-semibold', className)} {...props} />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="card-description" className={cn('text-muted-foreground text-xs', className)} {...props} />
  );
}

export function CardAction({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-3', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('flex items-center gap-2 px-3', className)} {...props} />;
}
