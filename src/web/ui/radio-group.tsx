import { CircleIcon } from 'lucide-react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@web/lib/cn';

export function RadioGroup({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root data-slot="radio-group" className={cn('grid gap-2', className)} {...props} />
  );
}

export function RadioGroupItem({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        'border-input text-brand focus-visible:ring-ring aria-invalid:border-destructive aspect-square size-3.5 shrink-0 rounded-full border shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon
          aria-hidden
          className="fill-brand absolute top-1/2 left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2"
        />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}
