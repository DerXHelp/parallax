import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { createContext, useContext, type ComponentProps } from 'react';
import { cn } from '@web/lib/cn';

/** True below a TooltipProvider: tooltips then share its delay and skip-delay (R1W-24). */
const ProviderPresent = createContext(false);

/** Mounted once around the app (AppShell, playground); `Tooltip` also works standalone (tests). */
export function TooltipProvider({
  delayDuration = 400,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <ProviderPresent value={true}>
      <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
    </ProviderPresent>
  );
}

export function Tooltip(props: ComponentProps<typeof TooltipPrimitive.Root>) {
  const hasProvider = useContext(ProviderPresent);
  const root = <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
  return hasProvider ? root : <TooltipProvider>{root}</TooltipProvider>;
}

export function TooltipTrigger(props: ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground border-border animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 z-50 max-w-80 rounded-md border px-2 py-1 text-xs text-balance shadow-md',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
