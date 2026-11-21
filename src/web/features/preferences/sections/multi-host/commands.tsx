import { createContext, useContext } from 'react';
import type { MultiHostConfig, RemoteAccessCheck, RemoteEvent, RemotePeerLevel } from '@shared/model';
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
  /** WP-107 (§B.13): the level the computer that types the code gets (chosen here, never remotely). */
  pair(level: RemotePeerLevel): Promise<PairingWindow>;
  cancelPairing(): Promise<void>;
  unpair(): Promise<void>;
  renewKey(): Promise<void>;
  check(): Promise<RemoteAccessCheck[]>;
  events(onlyRejected: boolean): Promise<RemoteEvent[]>;
  eventsSeen(): Promise<void>;
  /** WP-107: changes the level of the coupling (locally either way; every connection of it ends). */
  setPeerLevel(level: RemotePeerLevel): Promise<void>;
}

/** The real commands over the connection to this computer. */
export const localMultiHostCommands: MultiHostCommands = {
  configure: async (change) => (await sendCommand(null, { name: 'multiHost.configure', ...change })).config,
  pair: (level) => sendCommand(null, { name: 'remoteAccess.pair', level }),
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
  setPeerLevel: async (level) => {
    await sendCommand(null, { name: 'remoteAccess.setPeerLevel', level });
  },
};

const MultiHostCommandsContext = createContext<MultiHostCommands>(localMultiHostCommands);

/** Tests and playground demos: answers the section's commands with a double. */
export const MultiHostCommandsProvider = MultiHostCommandsContext.Provider;

export function useMultiHostCommands(): MultiHostCommands {
  return useContext(MultiHostCommandsContext);
}
