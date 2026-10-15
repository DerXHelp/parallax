import { TriangleAlertIcon } from 'lucide-react';
import { LOCAL_HOST_ID, type HostId } from '@shared/common';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useConnectionStatus, useHostCounter } from '@web/state/hooks';
import type { ConnectionStatus } from '@web/state/store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';

const DOT: Readonly<Record<ConnectionStatus, string>> = {
  connecting: 'bg-status-idle motion-safe:animate-pulse',
  open: 'bg-status-done',
  reconnecting: 'bg-warning motion-safe:animate-pulse',
  closed: 'bg-status-error',
};

/**
 * Small "Connected / Reconnecting …" status (dot + text, never color only). Server messages that
 * failed the contract are dropped silently by the connection; their count shows up here (R3-05),
 * so a contract drift of real SDK data is visible in the window (`data-invalid-messages`).
 */
export function ConnectionIndicator({
  hostId = LOCAL_HOST_ID,
  className,
}: {
  hostId?: HostId;
  className?: string;
}) {
  const t = useT();
  const status = useConnectionStatus(hostId);
  const invalid = useHostCounter('invalidMessages', hostId);
  return (
    <span
      data-slot="connection-indicator"
      data-status={status}
      data-invalid-messages={invalid > 0 ? invalid : undefined}
      className={cn('text-muted-foreground inline-flex items-center gap-1.5', className)}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', DOT[status])} />
      {t(`connection.status.${status}`)}
      {invalid > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-slot="invalid-messages"
              className="text-warning inline-flex items-center gap-0.5 tabular-nums"
            >
              <TriangleAlertIcon aria-hidden className="size-3" />
              <span aria-hidden>{invalid}</span>
              <span className="sr-only">{t('connection.invalidMessages', { count: invalid })}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t('connection.invalidMessages', { count: invalid })}</TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
