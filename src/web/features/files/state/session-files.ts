import { useCallback, useEffect, useRef, useState } from 'react';
import { parseSessionKey } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { SessionFile } from '@shared/model';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { useFileToolSignature } from './file-tools';

/**
 * "Files of this session" (WP-54, ADR-145): `files.session` when the panel opens and again 2 s after
 * the last finished file tool call (debounced – a burst of edits costs one request).
 */

export const SESSION_FILES_DEBOUNCE_MS = 2000;

export interface SessionFilesState {
  /** Newest `lastAt` first (server order); null before the first answer. */
  files: readonly SessionFile[] | null;
  truncated: boolean;
  error: ErrorPayload | null;
  loading: boolean;
}

export interface SessionFilesHandle extends SessionFilesState {
  refresh: () => void;
}

export type SessionFilesFetcher = (
  sessionKey: string,
) => Promise<{ files: readonly SessionFile[]; truncated: boolean }>;

const fetchOverHost: SessionFilesFetcher = async (sessionKey) => {
  const entryId = parseSessionKey(sessionKey)?.entryId;
  if (entryId === undefined) return { files: [], truncated: false };
  return sendCommand(sessionKey, { name: 'files.session', entryId });
};

export function useSessionFiles(
  sessionKey: string,
  fetcher: SessionFilesFetcher = fetchOverHost,
): SessionFilesHandle {
  const [state, setState] = useState<SessionFilesState>({
    files: null,
    truncated: false,
    error: null,
    loading: true,
  });
  /** Only the newest request may write (and none after unmount). */
  const latest = useRef<symbol | null>(null);

  const load = useCallback(() => {
    const request = Symbol('files.session');
    latest.current = request;
    fetcher(sessionKey).then(
      ({ files, truncated }) => {
        if (latest.current === request) setState({ files, truncated, error: null, loading: false });
      },
      (error: unknown) => {
        if (latest.current === request) {
          setState((previous) => ({ ...previous, error: errorPayloadOf(error), loading: false }));
        }
      },
    );
  }, [fetcher, sessionKey]);

  useEffect(() => {
    load();
    return () => {
      latest.current = null;
    };
  }, [load]);

  const signature = useFileToolSignature(sessionKey);
  const seen = useRef(signature);
  useEffect(() => {
    if (signature === seen.current) return undefined;
    if (seen.current === '') {
      // The session view just arrived (no view = ''): the load on mount already covers it.
      seen.current = signature;
      return undefined;
    }
    const timer = setTimeout(() => {
      seen.current = signature;
      load();
    }, SESSION_FILES_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [signature, load]);

  return { ...state, refresh: load };
}
