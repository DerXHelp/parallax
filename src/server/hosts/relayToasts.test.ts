import { describe, expect, it } from 'vitest';
import { LIMITS, type EntryId, type HostId } from '@shared/common';
import type { RemoteHost, Settings } from '@shared/model';
import type { Notification } from '@shared/protocol';
import {
  SAMPLE_REMOTE_HOST_ID,
  sampleId,
  sampleNotificationSettings,
  sampleRemoteHost,
  sampleSettings,
  sampleTime,
} from '@shared/samples';
import type { NotificationKind } from '@shared/status';
import type { ToastRequest, ToastResult } from '../lib/toast';
import type { RelayEvents } from './ports';
import {
  RELAY_TOAST_BODY,
  RELAY_TOAST_RATE,
  createRelayToasts,
  relayToastTag,
  type RelayToastsOptions,
} from './relayToasts';

const HOST: HostId = SAMPLE_REMOTE_HOST_ID;
const OTHER_HOST: HostId = 'computer-c';
const ENTRY: EntryId = sampleId('en', 1);
const ENTRY_2: EntryId = sampleId('en', 2);

function notification(p: Partial<Notification> = {}): Notification {
  return {
    id: 'n1',
    kind: 'permission',
    entryId: ENTRY,
    title: 'Auth service',
    delivery: 'system',
    at: sampleTime(),
    ...p,
  };
}

interface Rig {
  relay: RelayEvents;
  /** Sets `list()` and fires the change listeners. */
  setHosts(hosts: RemoteHost[]): void;
  shown: ToastRequest[];
  removed: string[];
  settings: { value: Settings };
  results: ToastResult[];
  listeners(): { relay: number; change: number };
  idle(): Promise<void>;
  close(): void;
}

function rig(extra: Partial<RelayToastsOptions> = {}): Rig {
  let hosts: RemoteHost[] = [
    sampleRemoteHost(),
    sampleRemoteHost({ hostId: OTHER_HOST, name: 'Computer C' }),
  ];
  const relayListeners = new Set<RelayEvents>();
  const changeListeners = new Set<() => void>();
  const shown: ToastRequest[] = [];
  const removed: string[] = [];
  const results: ToastResult[] = [];
  const settings = { value: sampleSettings() };
  const toasts = createRelayToasts({
    hosts: {
      list: () => hosts,
      onRelay: (listener) => {
        relayListeners.add(listener);
        return () => {
          relayListeners.delete(listener);
        };
      },
      onChange: (listener) => {
        changeListeners.add(listener);
        return () => {
          changeListeners.delete(listener);
        };
      },
    },
    settings: () => settings.value,
    enabled: true,
    show: (request) => {
      shown.push(request);
      return Promise.resolve(results.shift() ?? { kind: 'shown' });
    },
    remove: (tag) => {
      removed.push(tag);
      return Promise.resolve(results.shift() ?? { kind: 'removed' });
    },
    ...extra,
  });
  return {
    relay: {
      notify: (hostId, n) => {
        for (const listener of relayListeners) listener.notify(hostId, n);
      },
      clear: (hostId, entryId) => {
        for (const listener of relayListeners) listener.clear(hostId, entryId);
      },
    },
    setHosts(next) {
      hosts = next;
      for (const listener of changeListeners) listener();
    },
    shown,
    removed,
    settings,
    results,
    listeners: () => ({ relay: relayListeners.size, change: changeListeners.size }),
    idle: () => toasts.idle(),
    close: () => {
      toasts.close();
    },
  };
}

function withEvent(kind: NotificationKind, patch: { toast?: boolean; sound?: boolean }): Settings {
  const events = sampleNotificationSettings().events;
  return sampleSettings({
    notifications: sampleNotificationSettings({
      events: { ...events, [kind]: { ...events[kind], ...patch } },
    }),
  });
}

describe('relayToastTag (WP-81)', () => {
  it('unique per computer and session, at most 64 characters, never an entry id', () => {
    const tag = relayToastTag(HOST, ENTRY);
    expect(tag).toMatch(/^rl_[0-9a-f]{32}$/);
    expect(relayToastTag(HOST, ENTRY)).toBe(tag);
    const longest = relayToastTag('a'.repeat(32), ENTRY);
    expect(longest.length).toBeLessThanOrEqual(64);
    expect(new Set([tag, relayToastTag(OTHER_HOST, ENTRY), relayToastTag(HOST, ENTRY_2), ENTRY]).size).toBe(
      4,
    );
  });
});

describe('createRelayToasts (WP-81, ADR-211)', () => {
  it('shows the toast in the language of this computer, naming the other computer; no click without the handler', async () => {
    const r = rig();
    r.settings.value = sampleSettings({ language: 'de' });
    r.relay.notify(HOST, notification());
    await r.idle();
    expect(r.shown).toEqual([
      {
        title: 'Auth service – braucht eine Freigabe',
        body: RELAY_TOAST_BODY.de.replace('{host}', 'Computer B'),
        tag: relayToastTag(HOST, ENTRY),
        launchUri: null,
        silent: false,
      },
    ]);
  });

  it('a click opens the session of that computer when the protocol handler is registered (openOnClick)', async () => {
    const asked: EntryId[] = [];
    const r = rig({
      system: {
        toastLaunchUri: (entryId) => {
          asked.push(entryId);
          return `parallax://session/${entryId}`;
        },
      },
    });
    r.relay.notify(HOST, notification());
    await r.idle();
    expect(asked).toEqual([ENTRY]);
    expect(r.shown[0]?.launchUri).toBe(`parallax://session/${HOST}/${ENTRY}`);
    const off = rig({ system: { toastLaunchUri: () => null } });
    off.relay.notify(HOST, notification());
    await off.idle();
    expect(off.shown[0]?.launchUri).toBeNull();
  });

  it('the filters of this computer: Do not disturb and toast off → nothing, sound off → silent', async () => {
    const r = rig();
    r.settings.value = sampleSettings({ notifications: sampleNotificationSettings({ doNotDisturb: true }) });
    r.relay.notify(HOST, notification());
    r.settings.value = withEvent('permission', { toast: false });
    r.relay.notify(HOST, notification());
    await r.idle();
    expect(r.shown).toEqual([]);
    r.settings.value = withEvent('done', { sound: false });
    r.relay.notify(HOST, notification({ kind: 'done' }));
    await r.idle();
    expect(r.shown).toMatchObject([{ title: 'Auth service – done', silent: true }]);
  });

  it('only system deliveries of computers in the list; an empty title falls back to the computer name', async () => {
    const r = rig();
    r.relay.notify(HOST, notification({ delivery: 'in_app' }));
    r.relay.notify('computer-x', notification());
    await r.idle();
    expect(r.shown).toEqual([]);
    r.relay.notify(OTHER_HOST, notification({ title: ' ' }));
    await r.idle();
    expect(r.shown).toMatchObject([
      { title: 'Computer C – needs permission', tag: relayToastTag(OTHER_HOST, ENTRY) },
    ]);
  });

  it('clear removes the toast of that computer and session only (once, only if shown)', async () => {
    const r = rig();
    r.relay.notify(HOST, notification());
    r.relay.notify(OTHER_HOST, notification());
    r.relay.clear(HOST, ENTRY_2);
    r.relay.clear(HOST, ENTRY);
    r.relay.clear(HOST, ENTRY);
    await r.idle();
    expect(r.removed).toEqual([relayToastTag(HOST, ENTRY)]);
  });

  it('a removed computer takes its toasts with it; leaving the role takes all', async () => {
    const r = rig();
    r.relay.notify(HOST, notification());
    r.relay.notify(HOST, notification({ entryId: ENTRY_2 }));
    r.relay.notify(OTHER_HOST, notification());
    await r.idle();
    r.setHosts([sampleRemoteHost({ hostId: OTHER_HOST, name: 'Computer C' })]);
    await r.idle();
    expect(r.removed).toEqual([relayToastTag(HOST, ENTRY), relayToastTag(HOST, ENTRY_2)]);
    // Status changes of the remaining computer remove nothing.
    r.setHosts([sampleRemoteHost({ hostId: OTHER_HOST, name: 'Computer C', status: 'unreachable' })]);
    r.setHosts([]);
    await r.idle();
    expect(r.removed).toEqual([
      relayToastTag(HOST, ENTRY),
      relayToastTag(HOST, ENTRY_2),
      relayToastTag(OTHER_HOST, ENTRY),
    ]);
  });

  it('off: native toasts disabled here, or the engine channel failed for good', async () => {
    const disabled = rig({ enabled: false });
    disabled.relay.notify(HOST, notification());
    await disabled.idle();
    expect(disabled.shown).toEqual([]);
    const failedHere = rig({ available: () => false });
    failedHere.relay.notify(HOST, notification());
    await failedHere.idle();
    expect(failedHere.shown).toEqual([]);
  });

  it('a permanent failure switches it off for this run; transient failures pause it (CR-05)', async () => {
    const r = rig();
    r.results.push({ kind: 'failed', reason: 'language mode', permanent: true });
    r.relay.notify(HOST, notification());
    r.relay.notify(HOST, notification({ entryId: ENTRY_2 }));
    await r.idle();
    expect(r.shown).toHaveLength(1);

    let clock = 0;
    const t = rig({ now: () => clock });
    for (let i = 0; i < 3; i++) t.results.push({ kind: 'failed', reason: 'timeout', permanent: false });
    for (let i = 0; i < 4; i++) t.relay.notify(HOST, notification());
    await t.idle();
    // Three failures in a row → paused; the fourth is skipped.
    expect(t.shown).toHaveLength(3);
    clock = 60_000;
    t.relay.notify(HOST, notification());
    await t.idle();
    expect(t.shown).toHaveLength(4);
  });

  it('security review: at most RELAY_TOAST_RATE.max toasts per computer and minute, the rest dropped', async () => {
    let clock = 0;
    const r = rig({ now: () => clock });
    for (let i = 0; i < RELAY_TOAST_RATE.max + 5; i++) {
      r.relay.notify(HOST, notification({ id: `n${String(i)}`, entryId: i % 2 === 0 ? ENTRY : ENTRY_2 }));
    }
    // Another computer has its own budget.
    r.relay.notify(OTHER_HOST, notification());
    await r.idle();
    expect(r.shown.filter((t) => t.body.includes('Computer B'))).toHaveLength(RELAY_TOAST_RATE.max);
    expect(r.shown.filter((t) => t.body.includes('Computer C'))).toHaveLength(1);
    // One toast per session at a time: the same tag replaces, never stacks (two sessions, two tags).
    expect(new Set(r.shown.map((t) => t.tag))).toEqual(
      new Set([relayToastTag(HOST, ENTRY), relayToastTag(HOST, ENTRY_2), relayToastTag(OTHER_HOST, ENTRY)]),
    );
    // A minute later the budget is back.
    clock = RELAY_TOAST_RATE.windowMs;
    r.relay.notify(HOST, notification());
    await r.idle();
    expect(r.shown.filter((t) => t.body.includes('Computer B'))).toHaveLength(RELAY_TOAST_RATE.max + 1);
  });

  it('security review: the title is cut to LIMITS.titleChars before the text is built', async () => {
    const r = rig();
    r.relay.notify(HOST, notification({ title: 'x'.repeat(LIMITS.titleChars + 50) }));
    await r.idle();
    expect(r.shown[0]?.title).toBe(`${'x'.repeat(LIMITS.titleChars)} – needs permission`);
  });

  it('close stops listening', async () => {
    const r = rig();
    expect(r.listeners()).toEqual({ relay: 1, change: 1 });
    r.close();
    expect(r.listeners()).toEqual({ relay: 0, change: 0 });
    r.relay.notify(HOST, notification());
    await r.idle();
    expect(r.shown).toEqual([]);
  });
});
