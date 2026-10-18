import { afterEach, describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import type { Settings } from '@shared/model';
import { sampleNotificationSettings } from '@shared/samples';
import { createHostConnection, registerConnection, unregisterConnection } from './connection';
import { FakeHost } from './fake-host';
import { selectSettings, updateSettings } from './settings';
import { clientStore, resetClientStore } from './store';
import { createMemoryTransport } from './transport';

let host: FakeHost | null = null;

afterEach(() => {
  unregisterConnection();
  host?.dispose();
  host = null;
  resetClientStore();
});

/** A connected FakeHost; `fail` makes it refuse every `settings.update`. */
async function connect(fail: boolean): Promise<FakeHost> {
  const transport = createMemoryTransport();
  host = new FakeHost({
    transport,
    onCommand: (cmd) =>
      fail && cmd.name === 'settings.update'
        ? { ok: false, error: makeError('STORE_WRITE_FAILED') }
        : undefined,
  });
  const connection = createHostConnection({ hostId: 'local', createTransport: () => transport });
  registerConnection(connection);
  connection.start();
  await expect.poll(() => clientStore.getState().hosts.local?.hostState ?? null).not.toBeNull();
  return host;
}

const settings = () => selectSettings(clientStore.getState());

describe('updateSettings (R4W-15: every top-level field optimistic)', () => {
  it('applies idleSleep, notifications and promptSuggestions; the ack confirms them', async () => {
    const server = await connect(false);
    const idleSleep: Settings['idleSleep'] = { enabled: false, minutes: 45 };
    const notifications = sampleNotificationSettings({ volume: 0.2, doNotDisturb: true });
    await updateSettings({ idleSleep, notifications, promptSuggestions: true });
    expect(server.hostState.settings.idleSleep).toEqual(idleSleep);
    expect(settings().idleSleep).toEqual(idleSleep);
    expect(settings().notifications).toEqual(notifications);
    expect(settings().promptSuggestions).toBe(true);
  });

  it('shows every field before the answer and restores the previous value when the server refuses', async () => {
    await connect(true);
    const before = settings();
    const done = updateSettings({ idleSleep: { enabled: false, minutes: 45 }, port: 4800 });
    // Optimistic: in the store before the (refusing) answer arrives – not only language/theme.
    expect(settings().idleSleep).toEqual({ enabled: false, minutes: 45 });
    expect(settings().port).toBe(4800);
    await expect(done).rejects.toThrow();
    expect(settings()).toEqual(before);
  });

  it('a key present with undefined never erases the field', async () => {
    await connect(false);
    const before = settings();
    await updateSettings({ theme: 'light', idleSleep: undefined });
    expect(settings().idleSleep).toEqual(before.idleSleep);
    expect(settings().theme).toBe('light');
  });
});
