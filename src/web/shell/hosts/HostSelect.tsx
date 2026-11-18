import { CheckIcon, ChevronDownIcon, MonitorIcon } from 'lucide-react';
import { useId } from 'react';
import { LOCAL_HOST_ID, type HostId } from '@shared/common';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { HOST_BG } from '@web/lib/host-colors';
import type { HostLabel } from '@web/state/hosts';
import { Button } from '@web/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';

/** Color dot of a computer (this computer: a monitor symbol). */
function HostMark({ host }: { host: HostLabel | null }) {
  if (host === null) return <MonitorIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />;
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', HOST_BG[host.color])} />;
}

/**
 * Choice of the computer for "New session" (WP-80, WP-75 §4.4): this computer first, then the
 * list. A computer that cannot be used now shows its status and cannot be picked.
 */
export function HostSelect({
  hosts,
  value,
  onValueChange,
  id,
  labelId,
  describedBy,
}: {
  /** The other computers (display order). */
  hosts: readonly HostLabel[];
  value: HostId;
  onValueChange: (hostId: HostId) => void;
  id?: string;
  labelId?: string;
  describedBy?: string;
}) {
  const t = useT();
  const valueId = useId();
  const selected = value === LOCAL_HOST_ID ? null : (hosts.find((host) => host.hostId === value) ?? null);
  const nameOf = (host: HostLabel | null) => (host === null ? t('hosts.thisComputer') : host.name);
  const options: (HostLabel | null)[] = [null, ...hosts];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          variant="outline"
          data-slot="host-select"
          data-host-id={value}
          aria-labelledby={labelId === undefined ? undefined : `${labelId} ${valueId}`}
          aria-describedby={describedBy}
          className="h-8 w-full justify-between gap-2 text-left font-normal"
        >
          <span id={valueId} className="flex min-w-0 flex-1 items-center gap-2">
            <HostMark host={selected} />
            <span className="truncate">{nameOf(selected)}</span>
            {selected === null || selected.availability === 'available' ? null : (
              <span className="text-warning shrink-0 text-2xs">
                {t(`hosts.status.${selected.availability}`)}
              </span>
            )}
          </span>
          <ChevronDownIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-(--radix-dropdown-menu-trigger-width)">
        {options.map((host) => {
          const hostId = host?.hostId ?? LOCAL_HOST_ID;
          const availability = host?.availability ?? 'available';
          const available = availability === 'available';
          const current = hostId === value;
          return (
            <DropdownMenuItem
              key={hostId}
              data-host-option={hostId}
              disabled={!available && !current}
              aria-current={current ? 'true' : undefined}
              onSelect={() => {
                onValueChange(hostId);
              }}
            >
              <HostMark host={host} />
              <span className="min-w-0 flex-1 truncate">{nameOf(host)}</span>
              {available ? null : (
                <span className="text-muted-foreground shrink-0 text-2xs">
                  {t(`hosts.status.${availability}`)}
                </span>
              )}
              {current ? <CheckIcon aria-hidden className="size-3.5 shrink-0" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
