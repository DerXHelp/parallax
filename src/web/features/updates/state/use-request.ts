import { useEffect, useEffectEvent, useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import { updateHttpErrorOf } from '../lib/api';

/**
 * One GET of a dialog ("What's new", license, notices): loads once per `key` while mounted, aborts
 * on unmount or a new key; `retry` loads again. The previous answer of another key never shows.
 */

export interface RequestState<T> {
  loading: boolean;
  data: T | null;
  error: ErrorPayload | null;
  retry: () => void;
}

interface Result<T> {
  key: string;
  data: T | null;
  error: ErrorPayload | null;
}

export function useRequest<T>(key: string, load: (signal: AbortSignal) => Promise<T>): RequestState<T> {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result<T> | null>(null);
  const run = useEffectEvent((signal: AbortSignal) => load(signal));
  const current = `${key}#${String(attempt)}`;

  useEffect(() => {
    const controller = new AbortController();
    run(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ key: current, data, error: null });
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) {
          setResult({ key: current, data: null, error: updateHttpErrorOf(caught) });
        }
      },
    );
    return () => {
      controller.abort();
    };
  }, [current]);

  const shown = result?.key === current ? result : null;
  return {
    loading: shown === null,
    data: shown?.data ?? null,
    error: shown?.error ?? null,
    retry: () => {
      setAttempt((value) => value + 1);
    },
  };
}
