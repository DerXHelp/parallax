import {
  CircleCheckIcon,
  CircleXIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import type { MultiHostConfig, RemoteAccessCheck, RemoteAccessState } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { errorPayloadOf } from '@web/state/connection';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { needsFirewallHint, orderedChecks } from '../../lib/multi-host';
import { useMultiHostCommands } from './commands';
import { Part } from './Part';

/** `REMOTE_ACCESS_FAILED.params.reason` with an own explanation (src/shared/errors.ts, WP-76 §C.4). */
const FAILED_REASONS = ['port_in_use', 'bind', 'tls_unsupported', 'listen', 'store'] as const;
type FailedReason = (typeof FAILED_REASONS)[number];

function failedReason(error: ErrorPayload): FailedReason | null {
  if (error.code !== 'REMOTE_ACCESS_FAILED') return null;
  const reason = error.params.reason;
  return FAILED_REASONS.find((candidate) => candidate === reason) ?? null;
}

const CHECK_ICON = {
  ok: CircleCheckIcon,
  warning: TriangleAlertIcon,
  error: CircleXIcon,
} as const;

const CHECK_TONE = {
  ok: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
} as const;

function CheckRow({ check }: { check: RemoteAccessCheck }) {
  const { t } = useI18n();
  const Icon = CHECK_ICON[check.status];
  return (
    <li data-check={check.id} data-status={check.status} className="flex items-start gap-2">
      <Icon aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', CHECK_TONE[check.status])} />
      <div className="grid min-w-0 gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          {t(`preferences.multiHost.share.checks.names.${check.id}`)}
          {check.status === 'ok' ? (
            <span className="sr-only">{t('preferences.multiHost.share.checks.status.ok')}</span>
          ) : (
            <Badge variant={check.status === 'error' ? 'destructive' : 'warning'}>
              {t(`preferences.multiHost.share.checks.status.${check.status}`)}
            </Badge>
          )}
        </span>
        {check.status === 'ok' ? null : (
          <span className="text-muted-foreground text-2xs leading-relaxed">
            {t(`preferences.multiHost.share.checks.details.${check.id}.${check.status}`)}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * State of the remote-access listener (`HostState.remoteAccess`: listening, port, addresses,
 * error), the checks with "Check again" (`remoteAccess.check`) and the firewall hint of the first
 * start.
 */
export function AccessStatus({ state, config }: { state: RemoteAccessState; config: MultiHostConfig }) {
  const { t, tError, format } = useI18n();
  const commands = useMultiHostCommands();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<ErrorPayload | null>(null);
  /** The ack's checks, shown until the host state brings other ones. */
  const [fresh, setFresh] = useState<{ checks: RemoteAccessCheck[]; basis: string } | null>(null);
  const basis = JSON.stringify(state.checks);
  const checks = orderedChecks(fresh !== null && fresh.basis === basis ? fresh.checks : state.checks);
  const port = state.port ?? config.port;
  const reason = state.error === null ? null : failedReason(state.error);

  const recheck = () => {
    setChecking(true);
    setCheckError(null);
    commands
      .check()
      .then(
        (result) => {
          setFresh({ checks: result, basis });
        },
        (caught: unknown) => {
          setCheckError(errorPayloadOf(caught));
        },
      )
      .finally(() => {
        setChecking(false);
      });
  };

  return (
    <Part
      name="status"
      heading={t('preferences.multiHost.share.status.heading')}
      actions={
        <Badge data-slot="remote-listening" variant={state.listening ? 'success' : 'destructive'}>
          {state.listening
            ? t('preferences.multiHost.share.status.listening')
            : t('preferences.multiHost.share.status.stopped')}
        </Badge>
      }
    >
      <div className="text-muted-foreground grid gap-0.5 text-xs">
        {state.listening ? (
          <p>{t('preferences.multiHost.share.status.listeningOn', { port: String(port) })}</p>
        ) : null}
        <p>
          {state.addresses.length === 0
            ? t('preferences.multiHost.share.status.noAddresses')
            : t('preferences.multiHost.share.status.addresses', { addresses: format.list(state.addresses) })}
        </p>
        <p>{t('preferences.multiHost.share.status.hostName', { name: state.hostName })}</p>
      </div>
      {state.error === null ? null : (
        <Alert tone="error" data-slot="remote-access-error" title={tError(state.error)}>
          {reason === null
            ? undefined
            : t(`preferences.multiHost.share.status.failedReasons.${reason}`, { port: String(port) })}
        </Alert>
      )}
      {checks.length === 0 ? null : (
        <ul aria-label={t('preferences.multiHost.share.checks.label')} className="grid gap-1.5 text-xs">
          {checks.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>
      )}
      <div>
        <Button
          variant="outline"
          size="sm"
          data-action="remote-recheck"
          disabled={checking}
          onClick={recheck}
        >
          {checking ? (
            <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" />
          ) : (
            <RefreshCwIcon aria-hidden />
          )}
          {checking
            ? t('preferences.multiHost.share.checks.checking')
            : t('preferences.multiHost.share.checks.recheck')}
        </Button>
      </div>
      {checkError === null ? null : (
        <Alert tone="error" title={t('preferences.multiHost.share.checks.failed')}>
          {tError(checkError)}
        </Alert>
      )}
      {needsFirewallHint(state) ? (
        <Alert tone="info" data-slot="firewall-hint" title={t('preferences.multiHost.share.firewall.title')}>
          {t('preferences.multiHost.share.firewall.body')}
        </Alert>
      ) : null}
    </Part>
  );
}
