import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { WINDOWS_HOST_CAPABILITIES, type HostCapabilities } from '@shared/model';
import { POSIX_PATHS, WIN32_PATHS } from '@shared/paths';
import { SAMPLE_IDS, sampleHostState } from '@shared/samples';
import {
  getSessionCapabilities,
  getSessionPaths,
  selectHostFlavor,
  selectHostPaths,
  useHostPathKey,
  useSessionCapabilities,
  useSessionPaths,
} from './host-platform';
import { clientStore, resetClientStore, updateHost } from './store';

const LINUX_SERVER: HostCapabilities = {
  desktop: false,
  externalConsole: false,
  shellWindow: false,
  editor: false,
  fileManager: false,
  autostart: false,
  protocolHandler: false,
};
const REMOTE = 'pc-linux';
const LOCAL_KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
const REMOTE_KEY = makeSessionKey(REMOTE, SAMPLE_IDS.entry);

function linuxHost(hostId: string, capabilities: HostCapabilities = LINUX_SERVER): void {
  updateHost(clientStore, hostId, () => ({
    hostState: sampleHostState({ platform: 'linux', capabilities }),
  }));
}

afterEach(() => {
  resetClientStore();
});

describe('host platform (WP-104)', () => {
  it('is Windows while a host has not delivered its state (the UI before WP-104)', () => {
    const state = clientStore.getState();
    expect(selectHostFlavor(state, LOCAL_HOST_ID)).toBe('win32');
    expect(selectHostPaths(state, 'unknown')).toBe(WIN32_PATHS);
    expect(getSessionPaths(null)).toBe(WIN32_PATHS);
    expect(getSessionPaths('not a key')).toBe(WIN32_PATHS);
    expect(getSessionCapabilities(LOCAL_KEY)).toEqual(WINDOWS_HOST_CAPABILITIES);
  });

  it('follows the platform of the session host, not the browser: a Linux host next to a Windows one', () => {
    updateHost(clientStore, LOCAL_HOST_ID, () => ({ hostState: sampleHostState() }));
    linuxHost(REMOTE);
    expect(getSessionPaths(LOCAL_KEY)).toBe(WIN32_PATHS);
    expect(getSessionPaths(REMOTE_KEY)).toBe(POSIX_PATHS);
    expect(getSessionCapabilities(LOCAL_KEY).fileManager).toBe(true);
    expect(getSessionCapabilities(REMOTE_KEY)).toEqual(LINUX_SERVER);
  });

  it('hooks re-render when the host state arrives', () => {
    const { result } = renderHook(() => ({
      paths: useSessionPaths(REMOTE_KEY),
      capabilities: useSessionCapabilities(REMOTE_KEY),
    }));
    expect(result.current.paths).toBe(WIN32_PATHS);
    act(() => {
      linuxHost(REMOTE);
    });
    expect(result.current.paths).toBe(POSIX_PATHS);
    expect(result.current.capabilities.editor).toBe(false);
  });

  it('useHostPathKey compares folders case-sensitively only on Linux hosts and stays stable', () => {
    const { result, rerender } = renderHook(() => useHostPathKey());
    const windowsOnly = result.current;
    expect(windowsOnly(REMOTE, '/home/a/X')).toBe(windowsOnly(REMOTE, '/home/a/x'));
    act(() => {
      linuxHost(REMOTE);
    });
    const key = result.current;
    expect(key).not.toBe(windowsOnly);
    expect(key(REMOTE, '/home/a/X')).not.toBe(key(REMOTE, '/home/a/x'));
    expect(key(LOCAL_HOST_ID, 'D:\\Work')).toBe(key(undefined, 'd:\\work'));
    rerender();
    expect(result.current).toBe(key);
  });
});
