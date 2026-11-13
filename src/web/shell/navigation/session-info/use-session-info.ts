import { useCallback, useEffect, useRef, useState } from 'react';
import { parseSessionKey } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { SessionInfoOf, SessionInfoSection, SessionInfoSectionName } from '@shared/model';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';

/** What a tab shows (WP-67 §1.2): loading, the data, "not available", "not running – start?", an error. */
export type InfoLoad<S extends SessionInfoSectionName> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: SessionInfoOf<S> }
  | { kind: 'unavailable' }
  | { kind: 'notRunning' }
  | { kind: 'failed'; error: ErrorPayload };

export interface SessionInfoQuery<S extends SessionInfoSectionName> {
  load: InfoLoad<S>;
  /** A request is running (first load, refresh or start). */
  busy: boolean;
  /** A refresh failed while data stays on screen; the start failed. */
  error: ErrorPayload | null;
  refresh: () => void;
  /** "Start session": `session.resume` (no prompt, no turn), then the section again. */
  start: () => void;
}

function isSection<S extends SessionInfoSectionName>(
  data: SessionInfoSection,
  section: S,
): data is SessionInfoOf<S> {
  return data.section === section;
}

/**
 * One section of the session info, asked once when the tab opens and again on "Refresh" – no
 * polling, no cache (a reopened tab asks again). `SESSION_NOT_RUNNING` → "not running" (the server
 * never wakes a dormant session for this); other errors show in the tab (no toast). Answers of an
 * older request are ignored once a newer one is out.
 */
export function useSessionInfo<S extends SessionInfoSectionName>(
  sessionKey: string,
  section: S,
): SessionInfoQuery<S> {
  const [load, setLoad] = useState<InfoLoad<S>>({ kind: 'loading' });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const latest = useRef(0);
  const mounted = useRef(true);
  const entryId = parseSessionKey(sessionKey)?.entryId ?? null;

  /** One request; state changes only after the answer (the effect starts it without a sync setState). */
  const request = useCallback(
    async (id: number): Promise<void> => {
      if (entryId === null) return;
      try {
        const result = await sendCommand(sessionKey, { name: 'session.info', entryId, section });
        if (!mounted.current || id !== latest.current) return;
        const data = result.data;
        setLoad(
          result.available && data !== null && isSection(data, section)
            ? { kind: 'ready', data }
            : { kind: 'unavailable' },
        );
        setError(null);
      } catch (caught) {
        if (!mounted.current || id !== latest.current) return;
        const payload = errorPayloadOf(caught);
        if (payload.code === 'SESSION_NOT_RUNNING') {
          setLoad({ kind: 'notRunning' });
          setError(null);
        } else {
          // A failed refresh keeps the data on screen and shows the error above it.
          setLoad((current) => (current.kind === 'ready' ? current : { kind: 'failed', error: payload }));
          setError(payload);
        }
      } finally {
        if (mounted.current && id === latest.current) setBusy(false);
      }
    },
    [entryId, section, sessionKey],
  );

  useEffect(() => {
    mounted.current = true;
    void request(++latest.current);
    return () => {
      mounted.current = false;
    };
  }, [request]);

  const ask = useCallback(() => {
    setBusy(true);
    setError(null);
    void request(++latest.current);
  }, [request]);

  const refresh = ask;

  const start = useCallback(() => {
    if (entryId === null) return;
    const id = ++latest.current;
    setBusy(true);
    setError(null);
    sendCommand(sessionKey, { name: 'session.resume', entryId }).then(
      () => {
        if (mounted.current && id === latest.current) ask();
      },
      (caught: unknown) => {
        if (!mounted.current || id !== latest.current) return;
        setError(errorPayloadOf(caught));
        setBusy(false);
      },
    );
  }, [ask, entryId, sessionKey]);

  return { load, busy, error, refresh, start };
}

/** The `detail` param of an error (CLAUDE_CONTROL_FAILED of an action: the CLI's text), else null. */
export function errorDetail(error: ErrorPayload): string | null {
  const detail = error.params.detail;
  return typeof detail === 'string' && detail !== '' ? detail : null;
}
