import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, type LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@web/lib/cn';

type Tone = 'info' | 'warning' | 'error' | 'success';

const TONE_ICON: Readonly<Record<Tone, LucideIcon>> = {
  info: InfoIcon,
  warning: TriangleAlertIcon,
  error: CircleAlertIcon,
  success: CircleCheckIcon,
};

export const alertVariants = cva(
  'relative grid w-full grid-cols-[auto_1fr] items-start gap-x-2 gap-y-0.5 rounded-md border px-3 py-2 text-ui [&>svg]:mt-0.5 [&>svg]:size-3.5',
  {
    variants: {
      tone: {
        info: 'border-info/30 bg-info/8 [&>svg]:text-info',
        warning: 'border-warning/35 bg-warning/8 [&>svg]:text-warning',
        error: 'border-destructive/35 bg-destructive/8 [&>svg]:text-destructive',
        success: 'border-success/30 bg-success/8 [&>svg]:text-success',
      },
    },
    defaultVariants: { tone: 'info' },
  },
);

export interface AlertProps extends Omit<ComponentProps<'div'>, 'title'>, VariantProps<typeof alertVariants> {
  title?: ReactNode;
  /** Buttons on the right/bottom. */
  actions?: ReactNode;
}

/**
 * Inline message box (icon + text, the tone is never the only signal). `error` is announced
 * assertively (`role="alert"`), the others politely (`role="status"`).
 */
export function Alert({ className, tone, title, actions, children, ...props }: AlertProps) {
  const resolved: Tone = tone ?? 'info';
  const Icon = TONE_ICON[resolved];
  return (
    <div
      data-slot="alert"
      role={resolved === 'error' ? 'alert' : 'status'}
      className={cn(alertVariants({ tone: resolved }), className)}
      {...props}
    >
      <Icon aria-hidden />
      <div className="col-start-2 flex min-w-0 flex-col gap-0.5">
        {title === undefined ? null : <div className="font-medium">{title}</div>}
        {children === undefined ? null : <div className="text-muted-foreground text-xs">{children}</div>}
      </div>
      {actions === undefined ? null : (
        <div className="col-start-2 mt-1.5 flex flex-wrap gap-1.5">{actions}</div>
      )}
    </div>
  );
}

export interface BannerProps extends Omit<ComponentProps<'div'>, 'title'> {
  tone?: Tone;
  children: ReactNode;
  actions?: ReactNode;
}

const BANNER_TONE: Readonly<Record<Tone, string>> = {
  info: 'bg-info/10 border-info/25 [&>svg]:text-info',
  warning: 'bg-warning/10 border-warning/30 [&>svg]:text-warning',
  error: 'bg-destructive/10 border-destructive/30 [&>svg]:text-destructive',
  success: 'bg-success/10 border-success/25 [&>svg]:text-success',
};

/** Full-width strip at the top of a region (connection lost, setup hint, server warnings). */
export function Banner({ tone = 'info', className, children, actions, ...props }: BannerProps) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      data-slot="banner"
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex min-h-8 items-center gap-2 border-b px-3 py-1 text-xs [&>svg]:size-3.5 [&>svg]:shrink-0',
        BANNER_TONE[tone],
        className,
      )}
      {...props}
    >
      <Icon aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {actions === undefined ? null : <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}
