import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseServerMessage, sessionOpSchema } from '@shared/protocol';
import { sampleSessionSnapshot, sampleSettings } from '@shared/samples';
import { unregisterConnection } from '@web/state/connection';
import { FakeHost } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { createMemoryTransport } from '@web/state/transport';
import { PlaygroundApp } from './PlaygroundApp';
import { SCENARIOS, SCENARIO_IDS } from './scenarios';

// The playground renders every demo: 2 s in a full `pnpm test`, up to 20 s when several runs load
// the machine (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  unregisterConnection();
  resetClientStore();
  window.history.replaceState(null, '', '/');
});

describe('scenarios', () => {
  it('build schema-valid data for every scenario', () => {
    for (const id of SCENARIO_IDS) {
      const data = SCENARIOS[id].build(Date.parse('2026-10-15T08:00:00.000Z'), sampleSettings());
      for (const snapshot of data.sessions) {
        for (const item of snapshot.items)
          expect(sessionOpSchema.safeParse({ op: 'item.upsert', item }).success).toBe(true);
        for (const decision of snapshot.decisions) {
          expect(sessionOpSchema.safeParse({ op: 'decision.upsert', decision }).success).toBe(true);
        }
      }
    }
  });
});

describe('FakeHost', () => {
  it('answers subscribe with a snapshot, a replay or session.unavailable', () => {
    const transport = createMemoryTransport();
    const host = new FakeHost({ transport, sessions: [sampleSessionSnapshot()] });
    const received: string[] = [];
    transport.connect(
      (text) => received.push(text),
      () => undefined,
    );
    const entryId = sampleSessionSnapshot().entryId;
    transport.send(JSON.stringify({ type: 'subscribe', entryId }));
    host.pushOps(entryId, [{ op: 'item.remove', itemId: 'x' }]);
    transport.send(JSON.stringify({ type: 'subscribe', entryId, sinceSeq: 5 }));
    transport.send(JSON.stringify({ type: 'subscribe', entryId: 'en_ffffffffffffffffffffffffffffffff' }));
    const types = received.map((text) => {
      const parsed = parseServerMessage(text);
      return parsed.ok === true ? parsed.message.type : 'invalid';
    });
    expect(types).toEqual(['hello', 'session.snapshot', 'session.ops', 'session.ops', 'session.unavailable']);
    expect(host.view(entryId)?.seq).toBe(6);
    host.dispose();
  });
});

describe('PlaygroundApp', () => {
  it('lists the demos and opens a deep link', async () => {
    window.history.replaceState(null, '', '/#playground=ui-status-icons');
    const user = userEvent.setup();
    render(<PlaygroundApp />);
    const nav = screen.getByRole('navigation', { name: 'Demos' });
    expect(within(nav).getByText('UI – Primitives')).toBeTruthy();
    expect(screen.getByText('needs-resume')).toBeTruthy();
    await user.click(within(nav).getByText('Shell – All 14 display statuses'));
    expect(window.location.hash).toBe('#playground=shell-overview');
    expect(await screen.findByRole('navigation', { name: 'Sessions' })).toBeTruthy();
    act(() => {
      unregisterConnection();
    });
  });
});
