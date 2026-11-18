import { LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';
import { useEffect, useEffectEvent, useId, useState } from 'react';
import { LIMITS } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { RemoteAccessState, RemoteEvent } from '@shared/model';
import { useI18n } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Checkbox } from '@web/ui/checkbox';
import { Label } from '@web/ui/label';
import { formatEndpoint, isUnverifiedName } from '../../lib/multi-host';
import { useMultiHostCommands } from './commands';
import { Part } from './Part';

interface LoadResult {
  key: string;
  events: RemoteEvent[] | null;
  error: ErrorPayload | null;
}

function EventRow({ event }: { event: RemoteEvent }) {
  const { t, format } = useI18n();
  const unverified = isUnverifiedName(event);
  return (
    <tr
      data-event={event.kind}
      data-rejected={event.rejected ? 'true' : undefined}
      className="border-t align-top"
    >
      <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">
        <time dateTime={event.at}>{format.dateTime(event.at)}</time>
      </td>
      <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{formatEndpoint(event.address, event.port)}</td>
      <td className="py-1.5 pr-3">
        <span className="flex flex-wrap items-center gap-1.5">
          {t(`preferences.multiHost.share.log.kinds.${event.kind}`)}
          {event.rejected ? (
            <Badge variant="destructive">{t('preferences.multiHost.share.log.rejected')}</Badge>
          ) : null}
        </span>
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums">
        {t('preferences.multiHost.share.log.count', { count: format.number(event.count) })}
      </td>
      <td className="py-1.5">
        {event.claimedName === null ? (
          <span className="text-muted-foreground">{t('preferences.multiHost.share.log.noName')}</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="break-all">{event.claimedName}</span>
            {unverified ? (
              <Badge
                variant="warning"
                data-slot="unverified-name"
                title={t('preferences.multiHost.share.log.unverifiedHint')}
              >
                {t('preferences.multiHost.share.log.unverified')}
                <span className="sr-only">{t('preferences.multiHost.share.log.unverifiedHint')}</span>
              </Badge>
            ) : null}
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * Connection log of this computer (`remoteAccess.events`, newest first) with the filter "only
 * rejected". It loads when shown, on the filter, on new rejected attempts, on connect/disconnect
 * and on "Refresh"; showing it marks rejected attempts as seen (`remoteAccess.eventsSeen`).
 */
export function ConnectionLog({ state }: { state: RemoteAccessState }) {
  const { t, tError } = useI18n();
  const commands = useMultiHostCommands();
  const filterId = useId();
  const [onlyRejected, setOnlyRejected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LoadResult | null>(null);
  // New rejected attempts load the log again; marking them seen (back to 0) does not.
  const [unseen, setUnseen] = useState(state.unseenRejected);
  const [arrivals, setArrivals] = useState(0);
  if (state.unseenRejected !== unseen) {
    setUnseen(state.unseenRejected);
    if (state.unseenRejected > unseen) setArrivals((value) => value + 1);
  }
  const peer = state.peer;
  const key = [
    String(onlyRejected),
    String(attempt),
    String(arrivals),
    peer === null ? 'none' : `${peer.pairedAt}|${String(peer.connected)}`,
  ].join('#');

  const load = useEffectEvent((rejectedOnly: boolean) => commands.events(rejectedOnly));
  const markSeen = useEffectEvent(() => {
    if (state.unseenRejected === 0) return;
    // A failed mark only keeps the header hint; the next view tries again.
    commands.eventsSeen().catch(() => undefined);
  });

  useEffect(() => {
    let alive = true;
    load(onlyRejected).then(
      (events) => {
        if (!alive) return;
        setResult({ key, events, error: null });
        markSeen();
      },
      (caught: unknown) => {
        if (alive) setResult({ key, events: null, error: errorPayloadOf(caught) });
      },
    );
    return () => {
      alive = false;
    };
  }, [key, onlyRejected]);

  const loading = result?.key !== key;
  // While loading again the previous rows stay (no flicker); the first load shows a line.
  const events = result?.events ?? null;
  const error = result !== null && result.key === key ? result.error : null;
  const refresh = () => {
    setAttempt((value) => value + 1);
  };

  return (
    <Part
      name="log"
      heading={t('preferences.multiHost.share.log.heading')}
      hint={t('preferences.multiHost.share.log.hint', { days: LIMITS.remoteEventsDays })}
      actions={
        <Button variant="ghost" size="sm" data-action="log-refresh" disabled={loading} onClick={refresh}>
          {loading ? (
            <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" />
          ) : (
            <RefreshCwIcon aria-hidden />
          )}
          {t('preferences.multiHost.share.log.refresh')}
        </Button>
      }
    >
      <div className="flex items-center gap-2">
        <Checkbox
          id={filterId}
          data-slot="log-only-rejected"
          checked={onlyRejected}
          onCheckedChange={(checked) => {
            setOnlyRejected(checked === true);
          }}
        />
        <Label htmlFor={filterId} className="font-normal">
          {t('preferences.multiHost.share.log.onlyRejected')}
        </Label>
      </div>
      {error === null ? null : (
        <Alert
          tone="error"
          title={t('preferences.multiHost.share.log.failed')}
          actions={
            <Button size="sm" variant="outline" data-action="log-retry" onClick={refresh}>
              {t('preferences.multiHost.share.log.retry')}
            </Button>
          }
        >
          {tError(error)}
        </Alert>
      )}
      {events === null ? (
        loading ? (
          <p className="text-muted-foreground text-xs">{t('preferences.multiHost.share.log.loading')}</p>
        ) : null
      ) : events.length === 0 ? (
        <p data-slot="log-empty" className="text-muted-foreground text-xs">
          {onlyRejected
            ? t('preferences.multiHost.share.log.emptyRejected')
            : t('preferences.multiHost.share.log.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table
            data-slot="connection-log"
            aria-busy={loading ? true : undefined}
            className="w-full text-left text-xs"
          >
            <thead className="text-muted-foreground text-2xs">
              <tr>
                <th scope="col" className="pr-3 pb-1 font-medium">
                  {t('preferences.multiHost.share.log.columns.time')}
                </th>
                <th scope="col" className="pr-3 pb-1 font-medium">
                  {t('preferences.multiHost.share.log.columns.address')}
                </th>
                <th scope="col" className="pr-3 pb-1 font-medium">
                  {t('preferences.multiHost.share.log.columns.kind')}
                </th>
                <th scope="col" className="pr-3 pb-1 text-right font-medium">
                  {t('preferences.multiHost.share.log.columns.count')}
                </th>
                <th scope="col" className="pb-1 font-medium">
                  {t('preferences.multiHost.share.log.columns.name')}
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Part>
  );
}
