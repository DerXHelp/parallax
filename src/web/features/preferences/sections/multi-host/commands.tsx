import { createContext, useContext } from 'react';
import type { MultiHostConfig, RemoteAccessCheck, RemoteEvent } from '@shared/model';
import type { CommandOf, CommandResult } from '@shared/protocol';
import { sendCommand } from '@web/state/hooks';

/**
 * The commands of the section "Several computers" (WP-78b) – always to this computer (`local`),
 * never through another one. One seam for tests and playground demos: the default sends over the
 * host connection (`sendCommand`); `MultiHostCommandsProvider` swaps in a double. Every method
 * rejects with `ClientCommandError` (`errorPayloadOf` gives the ErrorPayload).
 */

/** The fields `multiHost.configure` changes (only the given ones). */
export type MultiHostChange = Omit<CommandOf<'multiHost.configure'>, 'name'>;
/** Ack of `remoteAccess.pair`: the code goes only to this window (never into HostState). */
export type PairingWindow = CommandResult<'remoteAccess.pair'>;

export interface MultiHostCommands {
  configure(change: MultiHostChange): Promise<MultiHostConfig>;
  pair(): Promise<PairingWindow>;
  cancelPairing(): Promise<void>;
  unpair(): Promise<void>;
  renewKey(): Promise<void>;
  check(): Promise<RemoteAccessCheck[]>;
  events(onlyRejected: boolean): Promise<RemoteEvent[]>;
  eventsSeen(): Promise<void>;
}

/** The real commands over the connection to this computer. */
export const localMultiHostCommands: MultiHostCommands = {
  configure: async (change) => (await sendCommand(null, { name: 'multiHost.configure', ...change })).config,
  pair: () => sendCommand(null, { name: 'remoteAccess.pair' }),
  cancelPairing: async () => {
    await sendCommand(null, { name: 'remoteAccess.cancelPairing' });
  },
  unpair: async () => {
    await sendCommand(null, { name: 'remoteAccess.unpair' });
  },
  renewKey: async () => {
    await sendCommand(null, { name: 'remoteAccess.renewKey' });
  },
  check: async () => (await sendCommand(null, { name: 'remoteAccess.check' })).checks,
  events: async (onlyRejected) =>
    (await sendCommand(null, { name: 'remoteAccess.events', onlyRejected })).events,
  eventsSeen: async () => {
    await sendCommand(null, { name: 'remoteAccess.eventsSeen' });
  },
};

const MultiHostCommandsContext = createContext<MultiHostCommands>(localMultiHostCommands);

/** Tests and playground demos: answers the section's commands with a double. */
export const MultiHostCommandsProvider = MultiHostCommandsContext.Provider;

export function useMultiHostCommands(): MultiHostCommands {
  return useContext(MultiHostCommandsContext);
}
