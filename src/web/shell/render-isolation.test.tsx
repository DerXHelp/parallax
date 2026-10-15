import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleId, sampleItems } from '@shared/samples';
import type * as FormatModule from '@web/i18n/format';
import { PLAYGROUND_ENTRIES, PLAYGROUND_SESSION_KEYS } from '@web/playground/scenarios';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { resetClientStore } from '@web/state/store';
import { AppShell } from './AppShell';
import { FeatureSlotsProvider, type FeatureSlots } from './slots';

/** Every SessionRow render formats its relative time exactly once – a render counter per row. */
const relative = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@web/i18n/format', async (importOriginal) => {
  const actual = await importOriginal<typeof FormatModule>();
  return {
    ...actual,
    formatRelativeTime: (...args: Parameters<typeof actual.formatRelativeTime>) => {
      relative.calls++;
      return actual.formatRelativeTime(...args);
    },
  };
});

let running: RunningScenario | null = null;
const renders = { transcript: 0, decisionBar: 0, composer: 0 };

const SLOTS: Partial<FeatureSlots> = {
  Transcript: () => {
    renders.transcript++;
    return null;
  },
  DecisionBar: () => {
    renders.decisionBar++;
    return null;
  },
  Composer: () => {
    renders.composer++;
    return null;
  },
};

afterEach(() => {
  running?.stop();
  running = null;
  resetClientStore();
  renders.transcript = 0;
  renders.decisionBar = 0;
  renders.composer = 0;
});

async function startOverview(): Promise<RunningScenario> {
  running = startScenario('overview');
  render(
    <FeatureSlotsProvider slots={SLOTS}>
      <AppShell />
    </FeatureSlotsProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Sample session' });
  return running;
}

describe('render isolation (R1W-04, R1W-05)', () => {
  it('deltas of the shown session do not re-render the pane slots', async () => {
    const scenario = await startOverview();
    const before = { ...renders };
    expect(before.transcript).toBeGreaterThan(0);
    const live = sampleItems.assistantText({ id: 'live:0', order: 6, text: '', streaming: true });
    await act(async () => {
      scenario.host.pushOps(PLAYGROUND_ENTRIES.main, [{ op: 'item.upsert', item: live }]);
      for (const chunk of ['Hel', 'lo', ' world']) {
        scenario.host.pushOps(PLAYGROUND_ENTRIES.main, [
          { op: 'item.delta', itemId: 'live:0', field: 'text', append: chunk },
        ]);
      }
      scenario.connection.flush();
      await Promise.resolve();
    });
    expect(scenario.host.view(PLAYGROUND_ENTRIES.main)?.items.at(-1)).toMatchObject({ text: 'Hello world' });
    expect(renders).toEqual(before);
  });

  it('a summary.upsert re-renders only its sidebar row, never the pane slots', async () => {
    const scenario = await startOverview();
    const nav = screen.getByRole('navigation', { name: 'Sessions' });
    expect(within(nav).getAllByRole('button')).toHaveLength(14);
    const slotsBefore = { ...renders };
    const rowsBefore = relative.calls;
    act(() => {
      // Another session: still the same position in the list (only the time changes).
      scenario.host.patchSummary(sampleId('en', 13), { lastActivityAt: '2026-10-14T06:00:00.000Z' });
    });
    expect(relative.calls - rowsBefore).toBe(1);
    act(() => {
      // The shown session itself (status facts): the header updates, the slots do not.
      scenario.host.patchSummary(PLAYGROUND_ENTRIES.main, {}, { unread: false });
    });
    expect(renders).toEqual(slotsBefore);
  });

  it('renders the decision bar region as focus target of "Go to decision"', async () => {
    await startOverview();
    const region = document.querySelector<HTMLElement>(
      `[data-decision-bar="${PLAYGROUND_SESSION_KEYS.main}"]`,
    );
    expect(region?.dataset.shortcutScope).toBe('decision-bar');
    expect(region?.tabIndex).toBe(-1);
  });
});
