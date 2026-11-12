import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import type { ToolCallItem } from '@shared/model';
import type { Command } from '@shared/protocol';
import { sampleItems } from '@shared/samples';
import { SidePanelHost } from '@web/shell/side-panel/SidePanelHost';
import { getSidePanelTab, openSidePanel, resetSidePanelState } from '@web/shell/side-panel/state';
import type { FakeAck, FakeHost } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { DecisionBar } from './DecisionBar';
import { DEMO_ENTRIES, DEMO_PLAN_V1, DEMO_PLANNING_PATH, type DemoEntry } from './lib/demo-data';
import { askPlanApproval, streamPlanWrite } from './lib/demo-plan';
import { renderWithHost, type Harness } from './lib/testing';
import { resetDecisionBarState } from './state/bar-store';
import { PlanFileError, resetPlanData, setPlanFileReader } from './state/plan-data';

vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  resetClientStore();
  resetDecisionBarState();
  resetSidePanelState();
  resetPlanData();
  localStorage.clear();
});

function start(
  entry: DemoEntry,
  options: { open?: boolean; onCommand?: (cmd: Command, host: FakeHost) => FakeAck | undefined } = {},
): Harness {
  const h = renderWithHost(
    (key) => (
      <>
        <SidePanelHost sessionKey={key(entry)} />
        <DecisionBar sessionKey={key(entry)} />
      </>
    ),
    { entries: [entry], onCommand: options.onCommand },
  );
  harness = h;
  if (options.open !== false) {
    act(() => {
      openSidePanel(h.key(entry), 'plan');
    });
  }
  return h;
}

async function findPanel(): Promise<HTMLElement> {
  const tab = await screen.findByRole('complementary', { name: 'Plan' });
  await waitFor(() => {
    expect(tab.querySelector('[data-slot="plan-panel"]')).not.toBeNull();
  });
  return tab;
}

function planPanel(tab: HTMLElement): HTMLElement {
  const panel = tab.querySelector<HTMLElement>('[data-slot="plan-panel"]');
  if (panel === null) throw new Error('plan panel missing');
  return panel;
}

function writeCall(order: number, p: Partial<ToolCallItem>): ToolCallItem {
  return sampleItems.toolCall({
    id: `msg_plan_${String(order)}:0`,
    messageId: `msg_plan_${String(order)}`,
    blockIndex: 0,
    order,
    toolUseId: `toolu_plan_${String(order)}`,
    toolName: 'Write',
    input: {},
    inputPartial: null,
    status: 'done',
    result: null,
    parentToolUseId: null,
    ...p,
  });
}

function finished(item: ToolCallItem, at: string): ToolCallItem {
  return {
    ...item,
    inputPartial: null,
    status: 'done',
    result: {
      isError: false,
      content: [{ type: 'text', text: { text: 'OK', truncated: null } }],
      structured: null,
      structuredTruncated: null,
      at,
    },
  };
}

describe('PlanPanel (side panel tab "Plan", WP-56)', () => {
  it('shows the open version with its status, the plan file and "Go to decision"', async () => {
    const h = start('plan');
    const tab = await findPanel();
    expect(await within(tab).findByRole('heading', { name: 'Plan v2' })).toBeTruthy();
    const panel = planPanel(tab);
    expect(panel.dataset.planView).toBe('v2');
    expect(panel.querySelector('[data-slot="plan-status"]')?.textContent).toBe('Open');
    expect(panel.querySelector('[data-slot="plan-file"]')).not.toBeNull();
    expect(within(tab).getByRole('button', { name: 'Go to decision' })).toBeTruthy();
    expect(within(tab).getByTestId('markdown').textContent).toContain('## Tests');
    // The open decision brings its own text: no plan.read for v2.
    await waitFor(() => {
      expect(h.commands('plan.list').length).toBeGreaterThan(0);
    });
    expect(h.commands('plan.read')).toEqual([]);
  });

  it('lists the versions newest first and reads an older one (plan.read)', async () => {
    const h = start('plan');
    const user = userEvent.setup();
    const tab = await findPanel();
    await within(tab).findByRole('heading', { name: 'Plan v2' });
    await user.click(within(tab).getByRole('button', { name: 'Plan version: v2' }));
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Plan file'),
      expect.stringContaining('v2Open'),
      expect.stringContaining('v1Rejected with feedback'),
    ]);
    await user.click(screen.getByRole('menuitemradio', { name: /^v1/ }));
    expect(await within(tab).findByRole('heading', { name: 'Plan v1' })).toBeTruthy();
    await waitFor(() => {
      expect(within(tab).getByTestId('markdown').textContent).toBe(DEMO_PLAN_V1);
    });
    expect(h.commands('plan.read').map((cmd) => cmd.version)).toEqual([1]);
    expect(planPanel(tab).querySelector('[data-slot="plan-status"]')?.textContent).toBe(
      'Rejected with feedback',
    );
  });

  it('"Changes to v1" shows the line diff (lazy chunk)', async () => {
    start('plan');
    const user = userEvent.setup();
    const tab = await findPanel();
    await user.click(await within(tab).findByRole('radio', { name: 'Changes to v1' }));
    await waitFor(() => {
      expect(tab.querySelector('[data-slot="diff"]')).not.toBeNull();
    });
    expect(planPanel(tab).dataset.planMode).toBe('changes');
    const added = [...tab.querySelectorAll('tr[data-kind="add"]')].map((row) => row.textContent);
    expect(added.some((text) => text.includes('## Tests'))).toBe(true);
    const removed = [...tab.querySelectorAll('tr[data-kind="remove"]')].map((row) => row.textContent);
    expect(removed.some((text) => text.includes('Replace the SQLite registry with JSON files.'))).toBe(true);
    await user.click(within(tab).getByRole('radio', { name: 'Plan' }));
    expect(within(tab).getByTestId('markdown')).toBeTruthy();
  });

  it('names approvals with their mode – "Implemented in a new conversation (Auto)" for a fresh context', async () => {
    start('approvedFresh');
    const tab = await findPanel();
    expect(await within(tab).findByRole('heading', { name: 'Plan v2' })).toBeTruthy();
    expect(planPanel(tab).querySelector('[data-slot="plan-status"]')?.textContent).toBe(
      'Implemented in a new conversation (Auto)',
    );
    await waitFor(() => {
      expect(within(tab).getByTestId('markdown').textContent).toContain('## Tests');
    });
    // Nothing to decide any more.
    expect(within(tab).queryByRole('button', { name: 'Go to decision' })).toBeNull();
  });

  it('shows "No plan yet" without versions and without a plan file', async () => {
    start('planning');
    const tab = await findPanel();
    expect(await within(tab).findByText('No plan yet')).toBeTruthy();
    expect(planPanel(tab).dataset.planView).toBe('none');
  });

  it('previews a running Write live, then loads the file after every finished write', async () => {
    const h = start('planning');
    const tab = await findPanel();
    await within(tab).findByText('No plan yet');
    const entryId = DEMO_ENTRIES.planning;
    const write = writeCall(10, {
      status: 'streaming_input',
      inputPartial: `{"file_path":${JSON.stringify(DEMO_PLANNING_PATH)},"content":"# Draft\\nfirst`,
    });
    act(() => {
      h.host.pushOps(entryId, [{ op: 'item.upsert', item: write }]);
    });
    await waitFor(() => {
      expect(tab.querySelector('[data-slot="plan-live"]')?.textContent).toBe('# Draft\nfirst');
    });
    expect(tab.querySelector('[data-slot="plan-writing"]')?.textContent).toContain('Being written…');
    expect(within(tab).getByRole('heading', { name: 'Current plan' })).toBeTruthy();
    // No stored version yet: nothing to compare with.
    expect(within(tab).queryByRole('radio', { name: /Changes to/ })).toBeNull();
    act(() => {
      h.host.pushOps(entryId, [
        { op: 'item.delta', itemId: write.id, field: 'inputPartial', append: ' line\\u00e' },
      ]);
    });
    await waitFor(() => {
      expect(tab.querySelector('[data-slot="plan-live"]')?.textContent).toBe('# Draft\nfirst line');
    });
    // Done: the file lands on "disk", the panel reads it (no live preview any more).
    act(() => {
      h.running.setPlanFile(DEMO_PLANNING_PATH, '# Draft\n\nfinal text');
      const input = { file_path: DEMO_PLANNING_PATH, content: '# Draft\n\nfinal text' };
      h.host.pushOps(entryId, [{ op: 'item.upsert', item: finished({ ...write, input }, h.host.now()) }]);
    });
    await waitFor(() => {
      expect(within(tab).getByTestId('markdown').textContent).toBe('# Draft\n\nfinal text');
    });
    expect(tab.querySelector('[data-slot="plan-live"]')).toBeNull();
    expect(tab.querySelector('[data-slot="plan-writing"]')).toBeNull();
    // A later Edit on the plan file loads it again.
    act(() => {
      h.running.setPlanFile(DEMO_PLANNING_PATH, '# Draft\n\nedited text');
      const edit = writeCall(11, {
        toolName: 'Edit',
        input: { file_path: DEMO_PLANNING_PATH, old_string: 'final', new_string: 'edited' },
      });
      h.host.pushOps(entryId, [
        { op: 'item.upsert', item: finished(edit, new Date(Date.now() + 5000).toISOString()) },
      ]);
    });
    await waitFor(() => {
      expect(within(tab).getByTestId('markdown').textContent).toBe('# Draft\n\nedited text');
    });
  });

  it('the playground stream (streamPlanWrite) ends with the written file as the plan file', async () => {
    const h = start('planning');
    const tab = await findPanel();
    await within(tab).findByText('No plan yet');
    const done = vi.fn();
    act(() => {
      streamPlanWrite(h.running, DEMO_ENTRIES.planning, {
        path: DEMO_PLANNING_PATH,
        text: '# Streamed\n\n- "quoted" ä 😀',
        steps: 5,
        intervalMs: 2,
        onDone: done,
      });
    });
    await waitFor(() => {
      expect(done).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(within(tab).getByTestId('markdown').textContent).toBe('# Streamed\n\n- "quoted" ä 😀');
    });
    expect(h.host.view(DEMO_ENTRIES.planning)?.detail.planFile?.path).toBe(DEMO_PLANNING_PATH);
  });

  it('a new plan decision never opens the panel by itself; once open it shows the new version', async () => {
    const h = start('planning', { open: false });
    act(() => {
      h.running.setPlanFile(DEMO_PLANNING_PATH, '# Plan v1');
      askPlanApproval(h.running, DEMO_ENTRIES.planning, {
        version: 1,
        text: '# Plan v1',
        path: DEMO_PLANNING_PATH,
        decision: 0xab1,
      });
    });
    expect(await screen.findByText('Plan v1 ready')).toBeTruthy();
    expect(getSidePanelTab(h.key('planning'))).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
    act(() => {
      openSidePanel(h.key('planning'), 'plan');
    });
    const tab = await findPanel();
    expect(await within(tab).findByRole('heading', { name: 'Plan v1' })).toBeTruthy();
    // v1 has no previous version: no diff toggle.
    expect(within(tab).queryByRole('radio', { name: /Changes to/ })).toBeNull();
  });

  it('falls back to the plan of the decision when the plan file cannot be loaded', async () => {
    start('plan');
    const user = userEvent.setup();
    setPlanFileReader(() => Promise.reject(new PlanFileError(makeError('FILE_NOT_FOUND'))));
    const tab = await findPanel();
    await user.click(await within(tab).findByRole('button', { name: 'Plan version: v2' }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Plan file/ }));
    expect(await within(tab).findByRole('heading', { name: 'Current plan' })).toBeTruthy();
    await waitFor(() => {
      expect(tab.querySelector('[data-slot="plan-file-fallback"]')?.textContent).toBe(
        'The plan file could not be loaded – this is the plan from the decision.',
      );
    });
    expect(within(tab).getByTestId('markdown').textContent).toContain('## Risks');
  });

  it('shows the plan file content in the "Plan file" view', async () => {
    start('plan');
    const user = userEvent.setup();
    const tab = await findPanel();
    await user.click(await within(tab).findByRole('button', { name: 'Plan version: v2' }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Plan file/ }));
    await waitFor(() => {
      expect(within(tab).getByTestId('markdown').textContent).toContain('## Tests');
    });
    expect(tab.querySelector('[data-slot="plan-file-fallback"]')).toBeNull();
    expect(planPanel(tab).dataset.planView).toBe('current');
  });

  it('a failed plan.read shows an error in the panel', async () => {
    start('approvedFresh', {
      onCommand: (cmd) => {
        if (cmd.name === 'plan.read') {
          return { ok: false, error: makeError('PLAN_NOT_FOUND', { version: cmd.version }) };
        }
        return undefined;
      },
    });
    const tab = await findPanel();
    await within(tab).findByRole('heading', { name: 'Plan v2' });
    const alert = await within(tab).findByRole('alert');
    expect(alert.textContent).toContain('The plan could not be loaded.');
  });

  it('a failed plan.list keeps the panel usable with what the client knows', async () => {
    start('plan', {
      onCommand: (cmd) =>
        cmd.name === 'plan.list' ? { ok: false, error: makeError('ENTRY_NOT_FOUND') } : undefined,
    });
    const tab = await findPanel();
    expect(await within(tab).findByText('The plan versions could not be loaded.')).toBeTruthy();
    expect(within(tab).getByRole('heading', { name: 'Plan v2' })).toBeTruthy();
    expect(within(tab).getByTestId('markdown').textContent).toContain('## Tests');
  });
});
