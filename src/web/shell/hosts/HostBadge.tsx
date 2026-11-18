import type { HostColor } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { HOST_BG, hostShortName } from '@web/lib/host-colors';
import type { HostAvailability } from '@web/state/hosts';

/**
 * Badge of another computer (WP-80, WP-75 §4.4): its color as a dot plus its short name – the
 * color never stands alone. The full name is in the accessible label ("Computer <name>"). Shown
 * only while other computers are part of the window (the callers check `useHasRemoteHosts`).
 */
export function HostBadge({
  name,
  color,
  availability = 'available',
  className,
}: {
  name: string;
  color: HostColor;
  /** A computer that cannot be used now shows its badge muted (its status is named elsewhere). */
  availability?: HostAvailability;
  className?: string;
}) {
  const t = useT();
  return (
    <span
      data-slot="host-badge"
      data-host-color={color}
      data-availability={availability}
      className={cn(
        'border-border text-muted-foreground inline-flex h-4 max-w-24 shrink-0 items-center gap-1 rounded-sm border px-1 text-2xs leading-none',
        availability !== 'available' && 'opacity-70',
        className,
      )}
    >
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', HOST_BG[color])} />
      <span aria-hidden className="truncate">
        {hostShortName(name)}
      </span>
      <span className="sr-only">{t('hosts.badge.label', { name })}</span>
    </span>
  );
}
