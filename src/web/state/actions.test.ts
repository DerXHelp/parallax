import { afterEach, describe, expect, it } from 'vitest';
import { makeSessionKey } from '@shared/common';
import type { Command } from '@shared/protocol';
import { SAMPLE_IDS, sampleItems, sampleSessionSnapshot } from '@shared/samples';
import { loadEarlier } from './actions';
import { createHostConnection, registerConnection, unregisterConnection } from './connection';
import { FakeHost, type FakeAck } from './fake-host';
import { clientStore, resetClientStore } from './store';
import { createMemoryTransport } from './transport';

const KEY = makeSessionKey('local', SAMPLE_IDS.entry);

function user(order: number) {
  return sampleItems.userMessage({ id: `px:item:${String(order)}`, order });
}

function connect(hasEarlier: boolean, onCommand: (cmd: Command) => FakeAck | undefined) {
  const transport = createMemoryTransport();
  const host = new FakeHost({
    transport,
    sessions: [sampleSessionSnapshot({ items: [10, 11, 12].map(user), hasEarlier })],
    onCommand,
  });
  const connection = createHostConnection({
    hostId: 'local',
    createTransport: () => transport,
    clientId: SAMPLE_IDS.client,
  });
  registerConnection(connection);
  connection.start();
  const release = connection.subscribe(SAMPLE_IDS.entry);
  return { host, release };
}

afterEach(() => {
  unregisterConnection();
  resetClientStore();
});

describe('loadEarlier', () => {
  it('asks for items before the oldest one and merges them (shared mergeItems)', async () => {
    const commands: Command[] = [];
    connect(true, (cmd) => {
      commands.push(cmd);
      return cmd.name === 'transcript.loadEarlier'
        ? { ok: true, result: { items: [8, 9, 10].map(user), hasEarlier: false } }
        : undefined;
    });
    const first = loadEarlier(KEY, { limit: 3 });
    expect(loadEarlier(KEY)).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(commands).toEqual([
      {
        name: 'transcript.loadEarlier',
        entryId: SAMPLE_IDS.entry,
        conversationId: SAMPLE_IDS.conversation,
        beforeOrder: 10,
        limit: 3,
      },
    ]);
    const view = clientStore.getState().sessions[KEY]?.view;
    expect(view?.items.map((item) => item.order)).toEqual([8, 9, 10, 11, 12]);
    expect(view?.hasEarlier).toBe(false);
  });

  it('does nothing without earlier items', async () => {
    const commands: Command[] = [];
    connect(false, (cmd) => {
      commands.push(cmd);
      return undefined;
    });
    await expect(loadEarlier(KEY)).resolves.toBe(false);
    expect(commands).toEqual([]);
  });
});
