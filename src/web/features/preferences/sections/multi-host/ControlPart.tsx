import {
  ArrowDownIcon,
  ArrowUpIcon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { LIMITS, type HostId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { RemoteHost } from '@shared/model';
import type { Command } from '@shared/protocol';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { HOST_BG } from '@web/lib/host-colors';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { useHostLabels, useOwnVersion, useRemoteHosts, type HostAvailability } from '@web/state/hosts';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';
import { HostFormDialog, type HostFormMode } from './HostFormDialog';
import { Part } from './Part';

type Status = 'connecting' | 'connected' | 'unreachable' | 'incompatible' | 'revoked';

/** The window's view of a computer (its connection and the server's watch), as the list names it. */
function statusOf(availability: HostAvailability): Status {
  return availability === 'available' ? 'connected' : availability;
}

const STATUS_BADGE: Readonly<Record<Status, 'success' | 'outline' | 'warning' | 'destructive'>> = {
  connected: 'success',
  connecting: 'outline',
  unreachable: 'warning',
  incompatible: 'warning',
  revoked: 'destructive',
};

interface Removing {
  host: RemoteHost;
  unreachable: boolean;
}

type Done = { key: 'done' | 'doneUnreachable'; name: string } | null;

function HostRow({
  host,
  index,
  count,
  status,
  busy,
  onRun,
  onEdit,
  onPairAgain,
  onRemove,
}: {
  host: RemoteHost;
  index: number;
  count: number;
  status: Status;
  busy: boolean;
  onRun: (cmd: Command) => void;
  onEdit: () => void;
  onPairAgain: () => void;
  onRemove: () => void;
}) {
  const { t, tError, format } = useI18n();
  const own = useOwnVersion();
  const name = host.name;
  let hint: string | null = null;
  if (status === 'incompatible') {
    hint =
      own === null
        ? t('preferences.multiHost.control.updateHintPlain', { name })
        : t('preferences.multiHost.control.updateHint', { name, version: own });
  } else if (status === 'revoked') {
    hint = t('preferences.multiHost.control.revokedHint', { name });
  } else if (status === 'unreachable' && host.lastError !== null) {
    hint = tError(host.lastError);
  }
  return (
    <li
      data-host-row={host.hostId}
      data-status={status}
      className="grid gap-2 border-b py-3 first:pt-0 last:border-b-0 last:pb-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span aria-hidden className={cn('size-2.5 shrink-0 rounded-full', HOST_BG[host.color])} />
        <span className="min-w-0 truncate text-xs font-medium">{name}</span>
        <Badge variant={STATUS_BADGE[status]} data-slot="host-status">
          {t(`preferences.multiHost.control.status.${status}`)}
        </Badge>
        <span className="flex-1" />
        <IconButton
          label={t('preferences.multiHost.control.actions.moveUp', { name })}
          disabled={busy || index === 0}
          data-action="host-move-up"
          onClick={() => {
            onRun({ name: 'hosts.move', hostId: host.hostId, index: index - 1 });
          }}
        >
          <ArrowUpIcon aria-hidden />
        </IconButton>
        <IconButton
          label={t('preferences.multiHost.control.actions.moveDown', { name })}
          disabled={busy || index === count - 1}
          data-action="host-move-down"
          onClick={() => {
            onRun({ name: 'hosts.move', hostId: host.hostId, index: index + 1 });
          }}
        >
          <ArrowDownIcon aria-hidden />
        </IconButton>
      </div>
      <div className="text-muted-foreground grid gap-0.5 text-2xs">
        <span className="font-mono" data-slot="host-address">
          {t('preferences.multiHost.control.address', { address: host.address, port: String(host.port) })}
        </span>
        <span data-slot="host-version">
          {host.appVersion === null
            ? t('preferences.multiHost.control.versionUnknown')
            : t('preferences.multiHost.control.version', { version: host.appVersion })}
          {' · '}
          {host.lastConnectedAt === null
            ? t('preferences.multiHost.control.neverConnected')
            : t('preferences.multiHost.control.lastConnected', {
                time: format.dateTime(host.lastConnectedAt),
              })}
        </span>
      </div>
      {hint === null ? null : (
        <p
          data-slot="host-hint"
          className={cn(
            'text-2xs leading-relaxed',
            status === 'unreachable' ? 'text-muted-foreground' : 'text-warning',
          )}
        >
          {hint}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {status === 'revoked' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-action="host-pair-again"
            onClick={onPairAgain}
          >
            <LinkIcon aria-hidden />
            {t('preferences.multiHost.control.actions.pairAgain')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || status === 'connected'}
            data-action="host-reconnect"
            onClick={() => {
              onRun({ name: 'hosts.reconnect', hostId: host.hostId });
            }}
          >
            <RefreshCwIcon aria-hidden />
            {t('preferences.multiHost.control.actions.reconnect')}
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={busy} data-action="host-edit" onClick={onEdit}>
          <PencilIcon aria-hidden />
          {t('preferences.multiHost.control.actions.edit')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} data-action="host-remove" onClick={onRemove}>
          <Trash2Icon aria-hidden />
          {t('preferences.multiHost.control.actions.remove')}
        </Button>
      </div>
    </li>
  );
}

/**
 * Part "Control others" of the section "Several computers" (WP-80, WP-75 §4.3): the sharing
 * computers this computer controls (`HostState.remoteHosts`, sidebar order) with status, version
 * and – for another version – the hint to update Parallax there (never from afar, A13); add one with
 * its pairing code, edit name/color/address/port, change the order, reconnect, pair again after the
 * other side removed the pairing, and remove one (asked first; an unreachable computer keeps its
 * pairing until it is removed there too). Every command goes to this computer; errors show here,
 * those of the form in its dialog.
 */
export function ControlPart() {
  const { t, tError } = useI18n();
  const hosts = useRemoteHosts();
  const labels = useHostLabels();
  const [form, setForm] = useState<HostFormMode | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; error: ErrorPayload } | null>(null);
  const [done, setDone] = useState<Done>(null);
  const full = hosts.length >= LIMITS.hostsMax;

  const run = (cmd: Command, title = t('preferences.multiHost.control.failed'), after?: () => void) => {
    setBusy(true);
    setError(null);
    setDone(null);
    sendCommand(null, cmd)
      .then(() => {
        after?.();
      })
      .catch((caught: unknown) => {
        setError({ title, error: errorPayloadOf(caught) });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const confirmRemove = (target: Removing) => {
    run(
      { name: 'hosts.remove', hostId: target.host.hostId },
      t('preferences.multiHost.control.remove.failed'),
      () => {
        setRemoving(null);
        setDone({ key: target.unreachable ? 'doneUnreachable' : 'done', name: target.host.name });
      },
    );
  };

  const statusOfHost = (hostId: HostId): Status => statusOf(labels.get(hostId)?.availability ?? 'connecting');

  return (
    <div data-slot="multi-host-control" className="grid gap-5">
      <Part
        name="hosts"
        heading={t('preferences.multiHost.control.heading')}
        hint={t('preferences.multiHost.control.hint')}
        actions={
          <Button
            size="sm"
            variant="outline"
            data-action="host-add"
            disabled={full}
            onClick={() => {
              setDone(null);
              setForm({ kind: 'add' });
            }}
          >
            <PlusIcon aria-hidden />
            {t('preferences.multiHost.control.add')}
          </Button>
        }
      >
        {full ? (
          <p className="text-muted-foreground text-2xs">
            {t('preferences.multiHost.control.limit', { max: LIMITS.hostsMax })}
          </p>
        ) : null}
        {hosts.length === 0 ? (
          <p data-slot="host-list-empty" className="text-muted-foreground text-xs leading-relaxed">
            {t('preferences.multiHost.control.empty')}
          </p>
        ) : (
          <ul aria-label={t('preferences.multiHost.control.list')} className="grid">
            {hosts.map((host, index) => (
              <HostRow
                key={host.hostId}
                host={host}
                index={index}
                count={hosts.length}
                status={statusOfHost(host.hostId)}
                busy={busy}
                onRun={(cmd) => {
                  run(cmd);
                }}
                onEdit={() => {
                  setForm({ kind: 'edit', host });
                }}
                onPairAgain={() => {
                  setForm({ kind: 'pairAgain', host, index });
                }}
                onRemove={() => {
                  setDone(null);
                  setRemoving({ host, unreachable: statusOfHost(host.hostId) === 'unreachable' });
                }}
              />
            ))}
          </ul>
        )}
        {removing === null ? null : (
          <Alert
            tone="warning"
            data-slot="host-remove-confirm"
            title={t('preferences.multiHost.control.remove.title', { name: removing.host.name })}
            actions={
              <>
                <Button
                  size="sm"
                  variant="outline"
                  autoFocus
                  disabled={busy}
                  data-action="host-remove-cancel"
                  onClick={() => {
                    setRemoving(null);
                  }}
                >
                  {t('preferences.multiHost.control.remove.cancel')}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  data-action="host-remove-confirm"
                  onClick={() => {
                    confirmRemove(removing);
                  }}
                >
                  {t('preferences.multiHost.control.remove.confirm')}
                </Button>
              </>
            }
          >
            {removing.unreachable
              ? t('preferences.multiHost.control.remove.bodyUnreachable', { name: removing.host.name })
              : t('preferences.multiHost.control.remove.body', { name: removing.host.name })}
          </Alert>
        )}
        {done === null ? null : (
          <Alert tone="success" data-slot="host-done">
            {t(`preferences.multiHost.control.remove.${done.key}`, { name: done.name })}
          </Alert>
        )}
        {error === null ? null : (
          <Alert tone="error" data-slot="host-error" title={error.title}>
            {tError(error.error)}
          </Alert>
        )}
      </Part>
      {form === null ? null : (
        <HostFormDialog
          mode={form}
          onClose={() => {
            setForm(null);
          }}
          onDone={() => {
            setForm(null);
          }}
        />
      )}
    </div>
  );
}
