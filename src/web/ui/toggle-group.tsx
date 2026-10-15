import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import { createContext, useContext, type ComponentProps } from 'react';
import { cn } from '@web/lib/cn';
import { toggleVariants, type ToggleVariantProps } from './toggle';

const ToggleGroupContext = createContext<ToggleVariantProps>({ size: 'default', variant: 'default' });

/** Segmented control (e.g. remember destination, approve mode); `type="single"` or `"multiple"`. */
export function ToggleGroup({
  className,
  variant,
  size,
  children,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Root> & ToggleVariantProps) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      className={cn(
        'group/toggle-group flex w-fit items-center rounded-md data-[variant=outline]:shadow-xs',
        className,
      )}
      {...props}
    >
      <ToggleGroupContext value={{ variant, size }}>{children}</ToggleGroupContext>
    </ToggleGroupPrimitive.Root>
  );
}

export function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Item> & ToggleVariantProps) {
  const context = useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={context.variant ?? variant}
      data-size={context.size ?? size}
      className={cn(
        toggleVariants({ variant: context.variant ?? variant, size: context.size ?? size }),
        'min-w-0 flex-1 shrink-0 rounded-none shadow-none first:rounded-l-md last:rounded-r-md focus:z-10 focus-visible:z-10 data-[variant=outline]:border-l-0 data-[variant=outline]:first:border-l',
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}
