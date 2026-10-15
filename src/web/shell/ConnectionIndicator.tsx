import { LOCAL_HOST_ID, type HostId } from '@shared/common';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useConnectionStatus } from '@web/state/hooks';
import type { ConnectionStatus } from '@web/state/store';

const DOT: Readonly<Record<ConnectionStatus, string>> = {
  connecting: 'bg-status-idle motion-safe:animate-pulse',
  open: 'bg-status-done',
  reconnecting: 'bg-warning motion-safe:animate-pulse',
  closed: 'bg-status-error',
};

/** Small "Connected / Reconnecting …" status (dot + text, never color only). */
export function ConnectionIndicator({
  hostId = LOCAL_HOST_ID,
  className,
}: {
  hostId?: HostId;
  className?: string;
}) {
  const t = useT();
  const status = useConnectionStatus(hostId);
  return (
    <span
      data-slot="connection-indicator"
      data-status={status}
      className={cn('text-muted-foreground inline-flex items-center gap-1.5', className)}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', DOT[status])} />
      {t(`connection.status.${status}`)}
    </span>
  );
}
