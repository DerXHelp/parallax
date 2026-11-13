import {
  ActivityIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CirclePauseIcon,
  CirclePlayIcon,
  ClipboardCheckIcon,
  ExternalLinkIcon,
  HourglassIcon,
  LoaderCircleIcon,
  MessageCircleQuestionMarkIcon,
  MoonIcon,
  ShieldAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { DISPLAY_STATUS_KINDS, type DisplayStatusKind } from '@shared/status';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

/**
 * WP-71: the pulse of a working session in dense lists (sidebar row, rail) – `strong` while it works
 * or starts, `soft` (slower, fainter) while only background tasks run.
 */
export type StatusPulse = 'strong' | 'soft';

/** Icon and color per display status (`DisplayStatusKind`, architecture §7). Text: `status.<kind>`. */
export interface StatusPresentation {
  icon: LucideIcon;
  /** Text color token class. */
  tone: string;
  /** Rotates while motion is allowed. */
  spin: boolean;
}

export const STATUS_PRESENTATION: Readonly<Record<DisplayStatusKind, StatusPresentation>> = {
  'needs-permission': { icon: ShieldAlertIcon, tone: 'text-status-waiting', spin: false },
  'needs-answer': { icon: MessageCircleQuestionMarkIcon, tone: 'text-status-waiting', spin: false },
  'needs-review': { icon: ClipboardCheckIcon, tone: 'text-status-waiting', spin: false },
  // ADR-016: own icon, distinct from the live decisions.
  'needs-resume': { icon: CirclePlayIcon, tone: 'text-status-waiting', spin: false },
  error: { icon: CircleAlertIcon, tone: 'text-status-error', spin: false },
  interrupted: { icon: CirclePauseIcon, tone: 'text-warning', spin: false },
  'rate-limited': { icon: HourglassIcon, tone: 'text-warning', spin: false },
  starting: { icon: CircleDashedIcon, tone: 'text-status-working', spin: true },
  working: { icon: LoaderCircleIcon, tone: 'text-status-working', spin: true },
  background: { icon: ActivityIcon, tone: 'text-status-working', spin: false },
  done: { icon: CircleCheckIcon, tone: 'text-status-done', spin: false },
  idle: { icon: CircleIcon, tone: 'text-status-idle', spin: false },
  sleeping: { icon: MoonIcon, tone: 'text-status-idle', spin: false },
  external: { icon: ExternalLinkIcon, tone: 'text-status-idle', spin: false },
};

/** WP-71: the kinds that pulse with `pulse` (all others never). */
export const STATUS_PULSE: Readonly<Partial<Record<DisplayStatusKind, StatusPulse>>> = {
  starting: 'strong',
  working: 'strong',
  background: 'soft',
};

/** All kinds (playground gallery, tests). */
export const STATUS_KINDS = DISPLAY_STATUS_KINDS;

export interface StatusIconProps {
  kind: DisplayStatusKind;
  /** Visible text next to the icon; otherwise the text is screen-reader only (never color only). */
  showLabel?: boolean;
  /** Tooltip with the text (icon-only usage in dense lists). */
  withTooltip?: boolean;
  /**
   * WP-71: working, starting and background sessions pulse (sidebar row, rail) – instead of the
   * spin, so a row has at most one animation.
   */
  pulse?: boolean;
  className?: string;
  iconClassName?: string;
}

/** Status icon + `t('status.<kind>')`. */
export function StatusIcon({
  kind,
  showLabel = false,
  withTooltip = false,
  pulse: pulsing = false,
  className,
  iconClassName,
}: StatusIconProps) {
  const t = useT();
  const presentation = STATUS_PRESENTATION[kind];
  const Icon = presentation.icon;
  const label = t(`status.${kind}`);
  const pulse = pulsing ? (STATUS_PULSE[kind] ?? null) : null;
  const icon = (
    <Icon
      aria-hidden
      className={cn(
        'size-3.5 shrink-0',
        presentation.tone,
        pulse === null ? presentation.spin && 'motion-safe:animate-spin' : 'relative',
        iconClassName,
      )}
    />
  );
  const content = (
    <span
      data-slot="status-icon"
      data-status={kind}
      data-pulse={pulse ?? undefined}
      className={cn('inline-flex min-w-0 items-center gap-1.5', className)}
    >
      {pulse === null ? (
        icon
      ) : (
        <span className="relative inline-flex shrink-0">
          {/* A disc in `status-working` that grows and fades (Tailwind `ping`) while motion is
              allowed – one CSS animation, no timer; with "reduce motion" a calm dot. Slower than
              Tailwind's 1 s (calm enough for many rows), `soft` slower and fainter still. */}
          <span
            aria-hidden
            data-slot="status-pulse"
            className={cn(
              'pointer-events-none absolute inset-0 rounded-full motion-safe:animate-ping',
              pulse === 'strong' ? 'bg-status-working/30' : 'bg-status-working/15',
            )}
            style={{ animationDuration: pulse === 'strong' ? '1.6s' : '3s' }}
          />
          {icon}
        </span>
      )}
      {showLabel ? <span className="truncate">{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
  if (!withTooltip) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
