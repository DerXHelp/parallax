import type { ComponentProps, ReactNode } from 'react';
import { Button, type ButtonProps } from './button';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

export interface IconButtonProps extends Omit<ButtonProps, 'aria-label' | 'children'> {
  /** Accessible name and tooltip text – always from `t()`. */
  label: string;
  /** The icon (lucide, with `aria-hidden`); the button's accessible name is `label`. */
  children: ReactNode;
  /** Shown next to the label in the tooltip, e.g. a `<Kbd>`. */
  shortcut?: ReactNode;
  /** Default true. */
  showTooltip?: boolean;
  tooltipSide?: ComponentProps<typeof TooltipContent>['side'];
}

/** Square icon-only button with an accessible name and a tooltip (never an unlabeled icon). */
export function IconButton({
  label,
  children,
  shortcut,
  showTooltip = true,
  tooltipSide,
  variant = 'ghost',
  size = 'icon-sm',
  ...props
}: IconButtonProps) {
  const button = (
    <Button aria-label={label} variant={variant} size={size} {...props}>
      {children}
    </Button>
  );
  if (!showTooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={tooltipSide}>
        <span className="inline-flex items-center gap-2">
          {label}
          {shortcut}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
