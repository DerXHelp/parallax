import { useFormat } from '@web/i18n';
import { cn } from '@web/lib/cn';

/** Level thresholds of the context gauge (Plan "Sidebar": from 70 % yellow, from 85 % red). */
export const GAUGE_THRESHOLDS = { warning: 70, danger: 85 } as const;

export type GaugeLevel = 'normal' | 'warning' | 'danger';

export function gaugeLevel(
  percent: number,
  thresholds: { warning: number; danger: number } = GAUGE_THRESHOLDS,
): GaugeLevel {
  if (percent >= thresholds.danger) return 'danger';
  if (percent >= thresholds.warning) return 'warning';
  return 'normal';
}

const FILL: Readonly<Record<GaugeLevel, string>> = {
  normal: 'bg-foreground/45',
  warning: 'bg-warning',
  danger: 'bg-destructive',
};

export interface GaugeProps {
  /** 0–100 (values above 100 are shown full). */
  value: number;
  /** Accessible name, from `t()` (e.g. "Context"). */
  label: string;
  /** Visible percentage next to the bar (default true; the level is then readable without color). */
  showValue?: boolean;
  className?: string;
  barClassName?: string;
  thresholds?: { warning: number; danger: number };
}

/**
 * Horizontal level meter (base of WP-16's ContextGauge): `role="meter"` with the formatted
 * percentage as `aria-valuetext`.
 */
export function Gauge({ value, label, showValue = true, className, barClassName, thresholds }: GaugeProps) {
  const format = useFormat();
  const clamped = Math.min(100, Math.max(0, value));
  const level = gaugeLevel(value, thresholds);
  const text = format.percent(value);
  return (
    <div
      data-slot="gauge"
      data-level={level}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-valuetext={text}
      className={cn('inline-flex items-center gap-1.5', className)}
    >
      <span className={cn('bg-muted relative h-1.5 w-16 overflow-hidden rounded-full', barClassName)}>
        <span
          className={cn('absolute inset-y-0 left-0 rounded-full transition-[width]', FILL[level])}
          style={{ width: `${String(clamped)}%` }}
        />
      </span>
      {showValue ? (
        <span
          className={cn(
            'text-2xs tabular-nums',
            level === 'normal'
              ? 'text-muted-foreground'
              : level === 'warning'
                ? 'text-warning'
                : 'text-destructive',
          )}
        >
          {text}
        </span>
      ) : null}
    </div>
  );
}
