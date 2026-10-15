import { useStore } from 'zustand';
import { LOCAL_HOST_ID, type HostId } from '@shared/common';
import type { Settings, SettingsPatch } from '@shared/model';
import { getConnection } from './connection';
import { clientStore, updateHost, type ClientState, type ClientStore } from './store';

/**
 * Settings of a host (`host.state.settings`, persisted by the server in settings.json). Without
 * host state (playground, before connecting) the window-local `localSettings` apply.
 */

export function selectSettings(state: ClientState, hostId: HostId = LOCAL_HOST_ID): Settings {
  return state.hosts[hostId]?.hostState?.settings ?? state.localSettings;
}

export function useSettings(hostId: HostId = LOCAL_HOST_ID): Settings {
  return useStore(clientStore, (state) => selectSettings(state, hostId));
}

function applyLocally(store: ClientStore, hostId: HostId, settings: Settings): void {
  const hostState = store.getState().hosts[hostId]?.hostState ?? null;
  if (hostState === null) {
    store.setState({ localSettings: settings });
    return;
  }
  updateHost(store, hostId, () => ({ hostState: { ...hostState, settings } }));
}

/**
 * `settings.update` with an optimistic local change; the ack (and the following `host.state`)
 * confirm it, an error restores the previous value and rethrows (ClientCommandError).
 */
export async function updateSettings(
  patch: SettingsPatch,
  hostId: HostId = LOCAL_HOST_ID,
  store: ClientStore = clientStore,
): Promise<Settings> {
  const previous = selectSettings(store.getState(), hostId);
  const optimistic: Settings = { ...previous, ...definedOnly(patch) };
  applyLocally(store, hostId, optimistic);
  if ((store.getState().hosts[hostId]?.hostState ?? null) === null) return optimistic;
  try {
    const { settings } = await getConnection(hostId).send({ name: 'settings.update', patch });
    applyLocally(store, hostId, settings);
    return settings;
  } catch (error) {
    if (selectSettings(store.getState(), hostId) === optimistic) applyLocally(store, hostId, previous);
    throw error;
  }
}

function definedOnly(patch: SettingsPatch): Partial<Settings> {
  const result: Partial<Settings> = {};
  if (patch.language !== undefined) result.language = patch.language;
  if (patch.theme !== undefined) result.theme = patch.theme;
  return result;
}
