/**
 * WP-81 (ADR-211, WP-75 §4.6) – notifications through the watcher of the controlling computer, with
 * the real manager, the FakeBackend and the memory publisher: where a native toast is due and the
 * user was last at the controlling computer, the watcher gets `notify{delivery:'system'}` instead of
 * the local toast; otherwise everything stays as before. The routing table itself is in
 * notifier.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientId, EntryId } from '@shared/common';
import { sampleId, sampleTime } from '@shared/samples';
import type { NotificationKind } from '@shared/status';
import type { ClientPresence } from '../sync/ports';
import type { NativeToasts } from './nativeToasts';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const harnesses: EngineHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(h.errors).toEqual([]);
  }
});

async function setup(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  const h = await createEngineHarness(options);
  harnesses.push(h);
  return h;
}

const RELAY: ClientId = sampleId('cl', 50);
const LOCAL_WINDOW: ClientId = sampleId('cl', 1);
const REMOTE_WINDOW: ClientId = sampleId('cl', 2);

function relay(connectedSec = 0): ClientPresence {
  return {
    clientId: RELAY,
    presence: { focused: false, visible: false, viewingEntryId: null, typing: false },
    lastFocusAt: null,
    connectedAt: new Date(sampleTime(connectedSec)),
    origin: 'remote',
    kind: 'relay',
  };
}

function window(
  clientId: ClientId,
  origin: 'local' | 'remote',
  focusSec: number | null,
  options: { focused?: boolean; web?: boolean } = {},
): ClientPresence {
  const focused = options.focused ?? false;
  return {
    clientId,
    presence: {
      focused,
      visible: focused,
      viewingEntryId: null,
      typing: false,
      ...(options.web === undefined ? {} : { systemNotifications: options.web }),
    },
    lastFocusAt: focusSec === null ? null : new Date(sampleTime(focusSec)),
    connectedAt: new Date(sampleTime(0)),
    ...(origin === 'remote' ? { origin, kind: 'window' as const } : {}),
  };
}

function toastDouble(): { toasts: NativeToasts; shown: { entryId: EntryId; kind: NotificationKind }[] } {
  const shown: { entryId: EntryId; kind: NotificationKind }[] = [];
  return {
    shown,
    toasts: {
      available: () => true,
      show: (entryId, kind) => {
        shown.push({ entryId, kind });
      },
      clear: () => undefined,
      idle: () => Promise.resolve(),
    },
  };
}

describe('notifications through the watcher (WP-81)', () => {
  it('no window here: the watcher gets notify{delivery: system}, no local toast', async () => {
    const { toasts, shown } = toastDouble();
    const h = await setup({ toasts, presence: [relay()] });
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.publisher.notifications.length === 1);
    await h.settle();
    expect(h.publisher.notifications).toEqual([
      {
        clientId: RELAY,
        notification: expect.objectContaining({
          entryId,
          kind: 'permission',
          title: 'fake:bash',
          delivery: 'system',
        }) as unknown,
      },
    ]);
    expect(shown).toEqual([]);
  });

  it('the user was last at this computer: the local toast as before, nothing for the watcher', async () => {
    const { toasts, shown } = toastDouble();
    // The local window was focused after the watcher connected; it is in the background now and
    // cannot show Web Notifications (in-app hint + native toast, WP22-03).
    const local = window(LOCAL_WINDOW, 'local', 10, { web: false });
    const h = await setup({ toasts, presence: [relay(0), local] });
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => shown.length === 1);
    await h.settle();
    expect(shown).toEqual([{ entryId, kind: 'permission' }]);
    expect(h.publisher.notifications.map((n) => [n.clientId, n.notification.delivery])).toEqual([
      [LOCAL_WINDOW, 'in_app'],
    ]);
  });

  it('a closed remote window that had the focus last still sends the toast to the watcher', async () => {
    const { toasts, shown } = toastDouble();
    // A local background window that cannot show Web Notifications (today: in-app + native toast).
    const local = window(LOCAL_WINDOW, 'local', 10, { web: false });
    const h = await setup({ toasts, presence: [relay(0), local] });
    // The remote window gets the focus, then closes (presence only lists open connections).
    const withRemote = [relay(0), local, window(REMOTE_WINDOW, 'remote', 20, { focused: true })];
    h.publisher.setPresence(withRemote);
    h.manager.onPresenceChanged(withRemote);
    h.publisher.setPresence([relay(0), local]);
    h.manager.onPresenceChanged([relay(0), local]);
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.publisher.notifications.length === 2);
    await h.settle();
    // The local window keeps its in-app hint; the toast goes to the watcher instead of this computer.
    expect(h.publisher.notifications.map((n) => [n.clientId, n.notification.delivery])).toEqual([
      [LOCAL_WINDOW, 'in_app'],
      [RELAY, 'system'],
    ]);
    expect(h.publisher.notifications.every((n) => n.notification.entryId === entryId)).toBe(true);
    expect(shown).toEqual([]);
  });

  it('an answered decision clears the notification everywhere (the hub broadcasts notify.clear)', async () => {
    const h = await setup({ presence: [relay()] });
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.publisher.notifications.length === 1);
    const [decision] = await h.decisions(entryId);
    if (decision === undefined) throw new Error('no decision');
    await h.cmd({
      name: 'decision.respond',
      entryId,
      decisionId: decision.id,
      response: { kind: 'permission', response: { behavior: 'allow', remember: null, acceptEdits: false } },
    });
    await h.waitFor(() => h.publisher.cleared.includes(entryId));
  });
});
