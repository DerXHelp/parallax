import { CheckIcon, LoaderCircleIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ErrorPayload } from '@shared/errors';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSessionDetail, useSummary } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { hasProcess } from '../navigation/session-actions';
import { useStyleT } from './i18n';

/**
 * WP-70: the output style of a session's project – the styles the CLI reported
 * (`detail.availableOutputStyles`), the current one (`summary.outputStyle`) marked. A click writes
 * it with `session.setOutputStyle` (`updateSettings('localSettings', {outputStyle})` in the
 * session's process; a dormant session starts without a turn) – it applies to every session of
 * the project from its next turn. Buttons, not a radio group: moving with the arrow keys never
 * writes the settings. Without a list: "Start session" (`session.resume`, the process reports
 * them). Archived and externally opened sessions: read only. Errors show here (ADR-126).
 * `heading`: embedded in the session info's status tab – own heading and hint, and no "Start
 * session" of its own (the tab has one).
 */
export function OutputStylePicker({
  sessionKey,
  heading = false,
}: {
  sessionKey: string;
  heading?: boolean;
}) {
  const st = useStyleT();
  const { tError } = useI18n();
  const summary = useSummary(sessionKey);
  const styles = useSessionDetail(sessionKey)?.availableOutputStyles ?? [];
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  if (summary === null) return null;
  const entryId = summary.entryId;
  const current = summary.outputStyle;
  const blocked = summary.archived ? st('archived') : summary.external === null ? null : st('external');
  const busy = pending !== null;

  const choose = (style: string) => {
    if (style === current || busy) return;
    setPending(style);
    setError(null);
    sendCommand(sessionKey, { name: 'session.setOutputStyle', entryId, style }).then(
      () => {
        setPending(null);
      },
      (caught: unknown) => {
        setPending(null);
        setError(errorPayloadOf(caught));
      },
    );
  };
  const start = () => {
    setPending('');
    setError(null);
    sendCommand(sessionKey, { name: 'session.resume', entryId }).then(
      () => {
        setPending(null);
      },
      (caught: unknown) => {
        setPending(null);
        setError(errorPayloadOf(caught));
      },
    );
  };

  let list: ReactNode = null;
  if (styles.length > 0) {
    list = (
      <ul className="grid gap-0.5" aria-label={st('title')}>
        {styles.map((style) => {
          const active = style === current;
          return (
            <li key={style}>
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={active}
                aria-label={st('choose', { style })}
                data-style={style}
                disabled={blocked !== null || busy}
                className={cn('w-full justify-start', active && 'bg-accent')}
                onClick={() => {
                  choose(style);
                }}
              >
                {pending === style ? (
                  <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" />
                ) : (
                  <CheckIcon aria-hidden className={active ? undefined : 'invisible'} />
                )}
                <span className="truncate">{style}</span>
                {active ? (
                  <span className="text-muted-foreground ml-auto text-2xs">{st('current')}</span>
                ) : null}
              </Button>
            </li>
          );
        })}
      </ul>
    );
  } else if (blocked !== null) {
    // The reason above is all there is to say.
  } else if (hasProcess(summary)) {
    list = <p className="text-muted-foreground text-xs">{st('none')}</p>;
  } else {
    list = (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground text-xs">{st('notRunning')}</p>
        {heading ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-action="output-style-start"
            onClick={start}
          >
            {st('start')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <section data-slot="output-style" data-current={current ?? undefined} className="grid gap-2">
      {heading ? (
        <div className="grid gap-0.5">
          <h3 className="text-sm font-medium">{st('title')}</h3>
          <p className="text-muted-foreground text-xs">{st('hint')}</p>
        </div>
      ) : null}
      {blocked === null ? null : <p className="text-muted-foreground text-xs">{blocked}</p>}
      {list}
      {busy ? (
        <span role="status" className="sr-only">
          {st('saving')}
        </span>
      ) : null}
      {error === null ? null : (
        <Alert tone="error" title={st('failed')}>
          {tError(error)}
        </Alert>
      )}
    </section>
  );
}
