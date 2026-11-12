import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostStateSchema, sessionDetailSchema, sessionSummarySchema } from '@shared/model';
import { parseServerMessage, sessionOpSchema } from '@shared/protocol';
import { sampleSessionSnapshot, sampleSettings } from '@shared/samples';
import { resetQuietSlotFailures } from '@web/shell/SlotBoundary';
import { unregisterConnection } from '@web/state/connection';
import { FakeHost } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { createMemoryTransport } from '@web/state/transport';
import { TooltipProvider } from '@web/ui/tooltip';
import { shellDemos } from './demos';
import { PlaygroundApp } from './PlaygroundApp';
import { SCENARIOS, SCENARIO_IDS } from './scenarios';

function shellDemo(id: string) {
  const found = shellDemos.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`demo ${id} missing`);
  return found;
}

// The playground renders every demo: 2 s in a full `pnpm test`, up to 20 s when several runs load
// the machine (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  unregisterConnection();
  resetClientStore();
  resetQuietSlotFailures();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('scenarios', () => {
  it('build schema-valid data for every scenario', () => {
    for (const id of SCENARIO_IDS) {
      const data = SCENARIOS[id].build(Date.parse('2026-10-15T08:00:00.000Z'), sampleSettings());
      expect(hostStateSchema.safeParse(data.hostState).success, id).toBe(true);
      for (const summary of data.summaries) {
        expect(sessionSummarySchema.safeParse(summary).success, `${id} ${summary.entryId}`).toBe(true);
      }
      for (const snapshot of data.sessions) {
        expect(sessionDetailSchema.safeParse(snapshot.detail).success, `${id} ${snapshot.entryId}`).toBe(
          true,
        );
      }
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
  it('lists the navigation demos of WP-35', () => {
    window.history.replaceState(null, '', '/#playground=ui-status-icons');
    render(<PlaygroundApp />);
    const nav = screen.getByRole('navigation', { name: 'Demos' });
    for (const title of [
      'Navigation – Sidebar flat (pinned first, limits at the bottom)',
      'Navigation – Sidebar grouped by project',
      'Navigation – Archive view (restore)',
      'Navigation – Quick switcher (Ctrl+K)',
      'Navigation – Header menu “…”',
      'Navigation – Banner: open in an external console',
      'Navigation – Banner: archived session',
    ]) {
      expect(within(nav).getByText(title)).toBeTruthy();
    }
  });

  it('lists the Phase 3 shell demos of WP-58 with the shell demos (no longer via the preferences playground)', () => {
    const ids = shellDemos.map((demo) => demo.id);
    for (const id of [
      'shell-header-panels',
      'shell-header-todos',
      'shell-session-menu',
      'shell-drop-overlay',
      'shell-window-900',
      'shell-window-700',
      'shell-app-busy',
      'shell-slot-error',
      'shell-slot-quiet',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the Phase 3 shell demos render: header buttons, slot error cards, the quiet variant', async () => {
    const { unmount } = render(
      <TooltipProvider>{shellDemo('shell-header-panels').render()}</TooltipProvider>,
    );
    // Two headers (900 and 480 px; happy-dom does not measure, so both stay wide here).
    expect(await screen.findAllByRole('button', { name: 'Tasks – 2 background tasks running' })).toHaveLength(
      2,
    );
    expect(screen.getAllByRole('button', { name: 'Plan' })).toHaveLength(2);
    unmount();
    act(() => {
      unregisterConnection();
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errors = render(<TooltipProvider>{shellDemo('shell-slot-error').render()}</TooltipProvider>);
    // The render error at once, the missing chunk once its import rejected.
    await waitFor(() => {
      expect(screen.getAllByText('This area could not be loaded')).toHaveLength(2);
    });
    errors.unmount();
    render(<TooltipProvider>{shellDemo('shell-slot-quiet').render()}</TooltipProvider>);
    const paragraph = document.querySelector('[data-slot="quiet-demo"]');
    await waitFor(() => {
      expect(paragraph?.textContent).toContain('D:\\work\\auth-service\\docs\\api.md');
    });
    expect(screen.queryByText('This area could not be loaded')).toBeNull();
    expect(paragraph?.querySelector('div')).toBeNull();
  });

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
