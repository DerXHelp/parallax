import { useMemo } from 'react';
import { useStore } from 'zustand';
import { LOCAL_HOST_ID, parseSessionKey, type HostId } from '@shared/common';
import { WINDOWS_HOST_CAPABILITIES, type HostCapabilities } from '@shared/model';
import {
  POSIX_PATHS,
  WIN32_PATHS,
  pathFlavorOf,
  pathRules,
  type PathFlavor,
  type PathRules,
} from '@shared/paths';
import { clientStore, type ClientState, type ClientStore } from './store';

/**
 * Platform of a host (WP-104, WP-100 §3.1 "Pfade je Host, nicht je Browser"): the path rules,
 * desktop capabilities and shell kinds of the computer a session or dialog belongs to – a Windows
 * window that controls a Linux computer takes `/home/…` there, and the other way round. Before a
 * host delivered its `host.state` everything is as on Windows (`WIN32_PATHS`,
 * `WINDOWS_HOST_CAPABILITIES`), which is what the UI did before WP-104.
 * The `select*` functions are pure (tests, non-React code reads `clientStore.getState()`), the
 * `use*` hooks re-render only when the platform or the capabilities of THAT host change.
 */

/** `host.state.platform` of a host, null before it delivered one. */
export function selectHostPlatform(state: ClientState, hostId: HostId): string | null {
  return state.hosts[hostId]?.hostState?.platform ?? null;
}

/** Path flavor of a host; `win32` while unknown. */
export function selectHostFlavor(state: ClientState, hostId: HostId): PathFlavor {
  const platform = selectHostPlatform(state, hostId);
  return platform === null ? 'win32' : pathFlavorOf(platform);
}

/** Path rules of a host (`pathRules(pathFlavorOf(platform))`); `WIN32_PATHS` while unknown. */
export function selectHostPaths(state: ClientState, hostId: HostId): PathRules {
  return pathRules(selectHostFlavor(state, hostId));
}

function hostOfSession(sessionKey: string | null): HostId {
  if (sessionKey === null) return LOCAL_HOST_ID;
  return parseSessionKey(sessionKey)?.hostId ?? LOCAL_HOST_ID;
}

/** Path rules of the host of a session (null or an invalid key: this computer). */
export function selectSessionPaths(state: ClientState, sessionKey: string | null): PathRules {
  return selectHostPaths(state, hostOfSession(sessionKey));
}

/** Desktop capabilities of a host; everything available while unknown (as before WP-104). */
export function selectHostCapabilities(state: ClientState, hostId: HostId): HostCapabilities {
  return state.hosts[hostId]?.hostState?.capabilities ?? WINDOWS_HOST_CAPABILITIES;
}

export function selectSessionCapabilities(state: ClientState, sessionKey: string | null): HostCapabilities {
  return selectHostCapabilities(state, hostOfSession(sessionKey));
}

/** Path rules of a host for code outside React (actions, menus). */
export function getHostPaths(hostId: HostId = LOCAL_HOST_ID, store: ClientStore = clientStore): PathRules {
  return selectHostPaths(store.getState(), hostId);
}

/** Path rules of the host of a session for code outside React. */
export function getSessionPaths(sessionKey: string | null, store: ClientStore = clientStore): PathRules {
  return selectSessionPaths(store.getState(), sessionKey);
}

/** Capabilities of the host of a session for code outside React. */
export function getSessionCapabilities(
  sessionKey: string | null,
  store: ClientStore = clientStore,
): HostCapabilities {
  return selectSessionCapabilities(store.getState(), sessionKey);
}

/** Path rules of a host (default: this computer). */
export function useHostPaths(hostId: HostId = LOCAL_HOST_ID): PathRules {
  return pathRules(useStore(clientStore, (state) => selectHostFlavor(state, hostId)));
}

/** Path rules of the host a session belongs to. */
export function useSessionPaths(sessionKey: string | null): PathRules {
  return useHostPaths(hostOfSession(sessionKey));
}

export function useHostCapabilities(hostId: HostId = LOCAL_HOST_ID): HostCapabilities {
  return useStore(clientStore, (state) => selectHostCapabilities(state, hostId));
}

export function useSessionCapabilities(sessionKey: string | null): HostCapabilities {
  return useHostCapabilities(hostOfSession(sessionKey));
}

/** Comparison key of a path on a host (`undefined`: this computer) – sidebar groups across hosts. */
export type HostPathKey = (hostId: HostId | undefined, path: string) => string;

/** Every path compared as on Windows (the default before WP-104 and while no host is known). */
export const WINDOWS_PATH_KEY: HostPathKey = (_hostId, path) => WIN32_PATHS.key(path);

/** The ids of the hosts with POSIX paths, sorted and joined – a primitive for `useStore`. */
function selectPosixHosts(state: ClientState): string {
  return Object.keys(state.hosts)
    .filter((hostId) => selectHostFlavor(state, hostId) === 'posix')
    .sort()
    .join('\n');
}

/** `HostPathKey` from the current host states; a new function only when a host's flavor changes. */
export function useHostPathKey(): HostPathKey {
  const posix = useStore(clientStore, selectPosixHosts);
  return useMemo(() => {
    if (posix === '') return WINDOWS_PATH_KEY;
    const hosts = new Set(posix.split('\n'));
    return (hostId, path) => (hosts.has(hostId ?? LOCAL_HOST_ID) ? POSIX_PATHS : WIN32_PATHS).key(path);
  }, [posix]);
}
