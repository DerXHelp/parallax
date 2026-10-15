import {
  BanIcon,
  CircleCheckIcon,
  CircleStopIcon,
  CircleXIcon,
  HourglassIcon,
  LayersIcon,
  LoaderCircleIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ToolCallStatus } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';

interface Presentation {
  icon: LucideIcon;
  className: string;
  spin: boolean;
  /** Also show the status text (not only to screen readers). */
  visible: boolean;
}

const PRESENTATION: Readonly<Record<ToolCallStatus, Presentation>> = {
  streaming_input: { icon: LoaderCircleIcon, className: 'text-muted-foreground', spin: true, visible: false },
  pending: { icon: LoaderCircleIcon, className: 'text-muted-foreground', spin: true, visible: false },
  awaiting_decision: { icon: HourglassIcon, className: 'text-status-waiting', spin: false, visible: true },
  running: { icon: LoaderCircleIcon, className: 'text-status-working', spin: true, visible: false },
  background: { icon: LayersIcon, className: 'text-status-working', spin: false, visible: true },
  done: { icon: CircleCheckIcon, className: 'text-status-done', spin: false, visible: false },
  error: { icon: CircleXIcon, className: 'text-status-error', spin: false, visible: true },
  denied: { icon: BanIcon, className: 'text-status-error', spin: false, visible: true },
  interrupted: { icon: CircleStopIcon, className: 'text-muted-foreground', spin: false, visible: true },
};

/** Status of a tool call: icon + text (never color only); the text is visible for notable states. */
export function ToolStatus({ status, className }: { status: ToolCallStatus; className?: string }) {
  const t = useT();
  const presentation = PRESENTATION[status];
  const Icon = presentation.icon;
  const label = t(`transcript.tool.status.${status}`);
  return (
    <span data-status={status} className={cn('inline-flex shrink-0 items-center gap-1', className)}>
      <Icon
        aria-hidden
        className={cn('size-3.5', presentation.className, presentation.spin && 'motion-safe:animate-spin')}
      />
      <span className={presentation.visible ? cn('text-2xs', presentation.className) : 'sr-only'}>
        {label}
      </span>
    </span>
  );
}
