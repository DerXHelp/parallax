import { NetworkIcon, Share2Icon } from 'lucide-react';
import type { RemoteAccessState } from '@shared/model';
import { useT, type t as translateNow } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useHostLabels, useMultiHostRole, useRemoteAccess, type HostLabel } from '@web/state/hosts';
import { IconButton } from '@web/ui/icon-button';
import { requestShell } from '../requests';

type TFunction = typeof translateNow;

/** Tone of the status dot (always next to a text: the button's label and tooltip). */
type Tone = 'ok' | 'idle' | 'warn';

const DOT: Readonly<Record<Tone, string>> = {
  ok: 'bg-success',
  idle: 'bg-muted-foreground',
  warn: 'bg-warning',
};

/** Status of a sharing computer: listener, connected controlling computer, unseen rejected attempts. */
export function shareStatus(t: TFunction, access: RemoteAccessState | null): { text: string; tone: Tone } {
  if (access === null) return { text: t('hosts.indicator.shareOff'), tone: 'idle' };
  if (access.error !== null) return { text: t('hosts.indicator.shareError'), tone: 'warn' };
  if (!access.listening) return { text: t('hosts.indicator.shareOff'), tone: 'warn' };
  const peer = access.peer;
  if (peer?.connected === true)
    return { text: t('hosts.indicator.shareConnected', { name: peer.name }), tone: 'ok' };
  return { text: t('hosts.indicator.shareListening'), tone: 'idle' };
}

/** Status of a controlling computer: how many of its computers are connected. */
export function controlStatus(t: TFunction, hosts: readonly HostLabel[]): { text: string; tone: Tone } {
  if (hosts.length === 0) return { text: t('hosts.indicator.controlNone'), tone: 'idle' };
  const connected = hosts.filter((host) => host.availability === 'available').length;
  if (connected === hosts.length)
    return { text: t('hosts.indicator.controlAll', { count: connected }), tone: 'ok' };
  return {
    text: t('hosts.indicator.controlSome', { connected, total: hosts.length }),
    tone: 'warn',
  };
}

/**
 * Icon of "Several computers" in the sidebar head (WP-80, WP-75 §4.4): role "share" – listener on
 * or off, whether the controlling computer is connected, and a counter of unseen rejected attempts
 * (`HostState.remoteAccess`); role "control" – how many computers are connected. A click opens the
 * settings section `multiHost`. Invisible without a role (and so in every README screenshot).
 */
export function MultiHostIndicator({
  placement = 'header',
}: {
  /** WP-90: in the rail of the collapsed sidebar (tooltip to the right). */
  placement?: 'header' | 'rail';
} = {}) {
  const t = useT();
  const rail = placement === 'rail';
  const role = useMultiHostRole();
  const access = useRemoteAccess();
  const hosts = useHostLabels();
  if (role === 'off') return null;
  const status = role === 'share' ? shareStatus(t, access) : controlStatus(t, hosts.list);
  const rejected = role === 'share' ? (access?.unseenRejected ?? 0) : 0;
  const parts = [status.text];
  if (rejected > 0) parts.push(t('hosts.indicator.rejected', { count: rejected }));
  parts.push(t('hosts.indicator.open'));
  const Icon = role === 'share' ? Share2Icon : NetworkIcon;
  return (
    <IconButton
      label={parts.join(' · ')}
      tooltipSide={rail ? 'right' : undefined}
      size={rail ? 'icon' : undefined}
      data-slot={rail ? 'rail-multi-host' : 'multi-host-indicator'}
      data-role={role}
      data-tone={status.tone}
      className="relative"
      onClick={() => {
        requestShell({ kind: 'settings', section: 'multiHost' });
      }}
    >
      <Icon aria-hidden />
      <span
        aria-hidden
        className={cn(
          'ring-sidebar absolute right-1 bottom-1 size-1.5 rounded-full ring-2',
          DOT[status.tone],
        )}
      />
      {rejected > 0 ? (
        <span
          aria-hidden
          data-slot="multi-host-rejected"
          className="bg-destructive text-destructive-foreground absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full px-0.5 text-center text-[0.625rem] leading-[0.875rem] tabular-nums"
        >
          {rejected > 9 ? t('navigation.panels.countOverflow', { max: 9 }) : rejected}
        </span>
      ) : null}
    </IconButton>
  );
}
