import { useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import type { MultiHostConfig } from '@shared/model';
import { errorPayloadOf } from '@web/state/connection';
import { useMultiHostCommands, type MultiHostChange } from './commands';

export interface ConfigureState {
  /** What to show: the running change, else the ack until the host state follows, else the host state. */
  config: MultiHostConfig;
  /** A `multiHost.configure` is running (role, port and address wait for it). */
  busy: boolean;
  /** Which field the running change touches (for a busy hint at the right place). */
  pending: MultiHostChange | null;
  configure: (change: MultiHostChange, onError: (error: ErrorPayload) => void) => void;
}

/**
 * `multiHost.configure` with an optimistic display: the change shows at once; after the ack its
 * config stays until `HostState.multiHost` changes (the broadcast may come after the ack); a
 * failure falls back to the host state and reports the error to the caller.
 */
export function useConfigure(actual: MultiHostConfig): ConfigureState {
  const commands = useMultiHostCommands();
  const [pending, setPending] = useState<MultiHostChange | null>(null);
  const [acked, setAcked] = useState<{ config: MultiHostConfig; basis: string } | null>(null);
  const basis = JSON.stringify(actual);
  const known = acked !== null && acked.basis === basis ? acked.config : actual;
  const config = pending === null ? known : { ...known, ...pending };

  const configure = (change: MultiHostChange, onError: (error: ErrorPayload) => void) => {
    setPending(change);
    commands
      .configure(change)
      .then(
        (next) => {
          setAcked({ config: next, basis });
        },
        (caught: unknown) => {
          onError(errorPayloadOf(caught));
        },
      )
      .finally(() => {
        setPending(null);
      });
  };

  return { config, busy: pending !== null, pending, configure };
}
