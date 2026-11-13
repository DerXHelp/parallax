import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import type { Command } from '@shared/protocol';
import { STORAGE_KEYS } from '@web/lib/storage';
import { createHostConnection, registerConnection, unregisterConnection } from './connection';
import { FakeHost } from './fake-host';
import { clientStore, resetClientStore } from './store';
import { createMemoryTransport } from './transport';
import {
  getTranscriptView,
  migrateLegacyTranscriptView,
  setTranscriptView,
  useTranscriptView,
} from './transcript-view';

let host: FakeHost | null = null;
const commands: Command[] = [];

afterEach(() => {
  unregisterConnection();
  host?.dispose();
  host = null;
  commands.length = 0;
  resetClientStore();
  window.localStorage.removeItem(STORAGE_KEYS.transcriptView);
});

async function connect(fail = false): Promise<FakeHost> {
  const transport = createMemoryTransport();
  host = new FakeHost({
    transport,
    onCommand: (cmd) => {
      commands.push(cmd);
      return fail && cmd.name === 'settings.update' ? { ok: false, error: makeError('STORE_WRITE_FAILED') } : undefined;
    },
  });
  const connection = createHostConnection({ hostId: 'local', createTransport: () => transport });
  registerConnection(connection);
  connection.start();
  await expect.poll(() => clientStore.getState().hosts.local?.hostState ?? null).not.toBeNull();
  return host;
}

describe('transcript view setting (WP-63 §1.5, WP-65 §1.6: settings.transcriptView)', () => {
  it('defaults to compact; a choice is a settings.update that every window follows', async () => {
    const server = await connect();
    const { result } = renderHook(() => useTranscriptView());
    expect(result.current).toBe('compact');
    await act(async () => {
      await setTranscriptView('all');
    });
    expect(result.current).toBe('all');
    expect(server.hostState.settings.transcriptView).toBe('all');
    expect(commands).toContainEqual({ name: 'settings.update', patch: { transcriptView: 'all' } });
    expect(window.localStorage.getItem(STORAGE_KEYS.transcriptView)).toBeNull();
  });

  it('takes a stored "all" of WP-63 over once and removes the key', async () => {
    window.localStorage.setItem(STORAGE_KEYS.transcriptView, 'all');
    // Before host.state: nothing happens (the key stays for later).
    await expect(migrateLegacyTranscriptView()).resolves.toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEYS.transcriptView)).toBe('all');
    const server = await connect();
    await expect(migrateLegacyTranscriptView()).resolves.toBe(true);
    expect(server.hostState.settings.transcriptView).toBe('all');
    expect(getTranscriptView()).toBe('all');
    expect(window.localStorage.getItem(STORAGE_KEYS.transcriptView)).toBeNull();
    // Once only: nothing stored any more.
    await expect(migrateLegacyTranscriptView()).resolves.toBe(false);
  });

  it('other stored values are only removed; a refused update keeps the key', async () => {
    window.localStorage.setItem(STORAGE_KEYS.transcriptView, 'bogus');
    await connect(true);
    await expect(migrateLegacyTranscriptView()).resolves.toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEYS.transcriptView)).toBeNull();
    expect(commands.some((cmd) => cmd.name === 'settings.update')).toBe(false);

    window.localStorage.setItem(STORAGE_KEYS.transcriptView, 'all');
    await expect(migrateLegacyTranscriptView()).rejects.toThrow();
    expect(window.localStorage.getItem(STORAGE_KEYS.transcriptView)).toBe('all');
    expect(getTranscriptView()).toBe('compact');
  });
});
