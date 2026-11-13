import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import type { Command } from '@shared/protocol';
import { createHostConnection, registerConnection, unregisterConnection } from './connection';
import { FakeHost } from './fake-host';
import { getHookDisplay, setHookDisplay, useHookDisplay } from './hook-display';
import { clientStore, resetClientStore } from './store';
import { createMemoryTransport } from './transport';

let host: FakeHost | null = null;
const commands: Command[] = [];

afterEach(() => {
  unregisterConnection();
  host?.dispose();
  host = null;
  commands.length = 0;
  resetClientStore();
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

describe('hook display setting (WP-69: settings.hookDisplay)', () => {
  it('defaults to failed; a choice is a settings.update that every window follows', async () => {
    const server = await connect();
    const { result } = renderHook(() => useHookDisplay());
    expect(result.current).toBe('failed');
    await act(async () => {
      await setHookDisplay('all');
    });
    expect(result.current).toBe('all');
    expect(getHookDisplay()).toBe('all');
    expect(server.hostState.settings.hookDisplay).toBe('all');
    expect(commands).toContainEqual({ name: 'settings.update', patch: { hookDisplay: 'all' } });
  });

  it('a refused update restores the previous value and rejects', async () => {
    await connect(true);
    const { result } = renderHook(() => useHookDisplay());
    await act(async () => {
      await expect(setHookDisplay('off')).rejects.toThrow();
    });
    expect(result.current).toBe('failed');
  });
});
