import { RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ErrorPayload } from '@shared/errors';
import {
  SESSION_INFO_LIMITS,
  type InfoRow,
  type InfoSettingsError,
  type SessionInfoOf,
  type SessionInfoSectionName,
} from '@shared/model';
import { tError } from '@web/i18n';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { useInfoT } from './i18n';
import { errorDetail, type SessionInfoQuery } from './use-session-info';

/** An error in a tab: the translated code plus the CLI's text when the server passed one. */
export function InfoError({ title, error }: { title: string; error: ErrorPayload }) {
  const it = useInfoT();
  const detail = errorDetail(error);
  return (
    <Alert tone="error" title={title} data-slot="session-info-error">
      {tError(error)}
      {detail === null ? null : (
        <span className="mt-0.5 block font-mono text-2xs break-all">{it('state.details', { detail })}</span>
      )}
    </Alert>
  );
}

/** "Only the first n entries are shown" under a list the server cut. */
export function TruncatedNote({ truncated }: { truncated: boolean }) {
  const it = useInfoT();
  if (!truncated) return null;
  return (
    <p className="text-muted-foreground text-2xs" data-slot="session-info-truncated">
      {it('state.truncated', { count: SESSION_INFO_LIMITS.listMax })}
    </p>
  );
}

/** Generic "label: value" rows of fields a newer CLI added (shown, not interpreted). */
export function ExtraRows({ rows }: { rows: readonly InfoRow[] }) {
  const it = useInfoT();
  if (rows.length === 0) return null;
  return (
    <section className="grid gap-1" data-slot="session-info-extra">
      <h4 className="text-muted-foreground text-2xs font-medium uppercase">{it('state.extra')}</h4>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        {rows.map((row, index) => (
          <div key={`${row.label ?? ''}:${String(index)}`} className="contents">
            <dt className="text-muted-foreground">{row.label ?? ''}</dt>
            <dd className="min-w-0 break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Settings files the CLI skipped – their rules/hooks are not in effect (permissions, hooks). */
export function SettingsErrors({ title, errors }: { title: string; errors: readonly InfoSettingsError[] }) {
  if (errors.length === 0) return null;
  return (
    <Alert tone="warning" title={title} data-slot="session-info-settings-errors">
      <ul className="grid gap-1">
        {errors.map((error, index) => (
          <li key={`${error.path}:${String(index)}`} className="grid text-2xs">
            <span className="font-mono break-all">{error.path}</span>
            <span>{error.message}</span>
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/**
 * The frame of every live tab (WP-67 §1.2): a toolbar with the tab's own actions and "Refresh", and
 * the states loading, data, "not available with this claude version", "session not running – start?"
 * and an error (inside the dialog, no toast).
 */
export function SectionFrame<S extends SessionInfoSectionName>({
  query,
  toolbar,
  children,
}: {
  query: SessionInfoQuery<S>;
  toolbar?: ReactNode;
  children: (data: SessionInfoOf<S>) => ReactNode;
}) {
  const it = useInfoT();
  const { load, busy, error } = query;
  return (
    <div className="grid gap-3" data-slot="session-info-section" data-state={load.kind} aria-busy={busy}>
      <div className="flex flex-wrap items-center gap-2">
        {load.kind === 'ready' ? toolbar : null}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          data-action="session-info-refresh"
          disabled={busy || load.kind === 'notRunning'}
          onClick={query.refresh}
        >
          {busy ? <Spinner aria-hidden /> : <RefreshCwIcon aria-hidden />}
          {it('state.refresh')}
        </Button>
      </div>
      {error === null || load.kind === 'failed' ? null : (
        <InfoError title={it('state.failed')} error={error} />
      )}
      {load.kind === 'loading' ? (
        <p role="status" className="text-muted-foreground flex items-center gap-2 text-xs">
          <Spinner aria-hidden />
          {it('state.loading')}
        </p>
      ) : null}
      {load.kind === 'unavailable' ? (
        <Alert tone="info" title={it('state.unavailable')} data-slot="session-info-unavailable">
          {it('state.unavailableHint')}
        </Alert>
      ) : null}
      {load.kind === 'notRunning' ? (
        <Alert
          tone="warning"
          title={it('state.notRunning')}
          data-slot="session-info-not-running"
          actions={
            <Button
              size="sm"
              variant="outline"
              data-action="session-info-start"
              disabled={busy}
              onClick={query.start}
            >
              {it('state.start')}
            </Button>
          }
        >
          {it('state.notRunningHint')}
        </Alert>
      ) : null}
      {load.kind === 'failed' ? <InfoError title={it('state.failed')} error={load.error} /> : null}
      {load.kind === 'ready' ? children(load.data) : null}
    </div>
  );
}
