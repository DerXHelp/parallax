import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleContextBreakdown, sampleContextGauge, sampleModelOption } from '@shared/samples';
import { resetClientStore } from '@web/state/store';
import { DEMO_ENTRIES, type DemoEntry } from '../decisions/lib/demo-data';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { ContextGauge } from './ContextGauge';
import { DEMO_MODELS_14 } from './demo/data';
import { ModelPicker } from './ModelPicker';
import { MODE_CYCLE_SEND_DELAY_MS, ModePicker } from './ModePicker';

// UI tests with many key strokes: 2.5–6 s in a full `pnpm test`, up to 21 s when several runs load
// the machine (docs/wp/FLAKES.md). A timed-out test keeps typing into the next one, so keep a margin.
vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  resetClientStore();
  localStorage.clear();
});

function start(entry: DemoEntry, ui: 'mode' | 'model' | 'gauge'): Harness {
  harness = renderWithHost(
    (key) =>
      ui === 'mode' ? (
        <ModePicker sessionKey={key(entry)} />
      ) : ui === 'model' ? (
        <ModelPicker sessionKey={key(entry)} />
      ) : (
        <ContextGauge sessionKey={key(entry)} />
      ),
    { entries: [entry] },
  );
  // The pickers read the session detail: keep the session subscribed like the pane does.
  harness.running.connection.subscribe(DEMO_ENTRIES[entry]);
  return harness;
}

describe('ModePicker (C.3)', () => {
  it('shows the ACTUAL mode and sends setPermissionMode; the label follows the server', async () => {
    const h = start('idle', 'mode');
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Permission mode: Manual' });
    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitemradio', { name: /Bypass permissions/ })).toBeNull();
    await user.click(within(menu).getByRole('menuitemradio', { name: /^Plan/ }));
    expect(h.commands('session.setPermissionMode')).toEqual([
      { name: 'session.setPermissionMode', entryId: DEMO_ENTRIES.idle, mode: 'plan' },
    ]);
    // The FakeHost updates the summary (like init/status of the CLI) – only then the label changes.
    expect(await screen.findByRole('button', { name: 'Permission mode: Plan' })).toBeTruthy();
  });

  it('does not change the label optimistically', async () => {
    const h = renderWithHost((key) => <ModePicker sessionKey={key('idle')} />, {
      entries: ['idle'],
      onCommand: (cmd) => (cmd.name === 'session.setPermissionMode' ? { ok: true, result: {} } : undefined),
    });
    harness = h;
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Permission mode: Manual' }));
    await user.click(await screen.findByRole('menuitemradio', { name: /^Auto/ }));
    await waitFor(() => {
      expect(h.commands('session.setPermissionMode')).toHaveLength(1);
    });
    expect(screen.getByRole('button', { name: 'Permission mode: Manual' })).toBeTruthy();
  });

  it('offers bypass (red) only when the profile allows it', async () => {
    start('bypass', 'mode');
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Permission mode: Bypass permissions' });
    expect(trigger.className).toContain('text-destructive');
    await user.click(trigger);
    const item = await screen.findByRole('menuitemradio', { name: /Bypass permissions/ });
    expect(item.className).toContain('text-destructive');
  });

  it('before the first start: "CLI default" instead of "Unknown mode"; after init an unknown mode stays unknown (V2-05)', async () => {
    const h = start('idle', 'mode');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Permission mode: Manual' });
    const init = h.host.view(DEMO_ENTRIES.idle)?.detail.init ?? null;
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, { permissionMode: null });
      h.host.pushOps(DEMO_ENTRIES.idle, [{ op: 'detail.patch', patch: { init: null } }]);
    });
    const trigger = await screen.findByRole('button', { name: 'Permission mode: CLI default' });
    expect(trigger.dataset.mode).toBe('not-started');
    await user.click(trigger);
    expect(await screen.findByText(/Not started yet: Claude Code starts with the default mode/)).toBeTruthy();
    await user.keyboard('{Escape}');
    if (init === null) throw new Error('demo session without init');
    act(() => {
      h.host.pushOps(DEMO_ENTRIES.idle, [
        { op: 'detail.patch', patch: { init: { ...init, permissionMode: null } } },
      ]);
    });
    expect(await screen.findByRole('button', { name: 'Permission mode: Unknown mode' })).toBeTruthy();
  });

  it('shows a mode set outside Parallax (dontAsk) without offering it', async () => {
    const h = start('idle', 'mode');
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, { permissionMode: 'dontAsk' });
    });
    expect(await screen.findByRole('button', { name: "Permission mode: Don't ask" })).toBeTruthy();
  });
});

/** ModePicker beside a text field like in the composer (WP-91: Shift+Tab only inside it). */
function CycleHarness({ sessionKey, blocked = false }: { sessionKey: string; blocked?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <textarea ref={ref} aria-label="message" />
      <ModePicker sessionKey={sessionKey} inputRef={ref} cycleBlocked={blocked} />
    </>
  );
}

function startCycle(entry: DemoEntry, blocked = false): Harness {
  harness = renderWithHost((key) => <CycleHarness sessionKey={key(entry)} blocked={blocked} />, {
    entries: [entry],
  });
  harness.running.connection.subscribe(DEMO_ENTRIES[entry]);
  return harness;
}

describe('ModePicker: Shift+Tab (WP-91, GitHub #2)', () => {
  it('names the target at once and sends only the last one after a pause', async () => {
    const h = startCycle('idle');
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Permission mode: Manual' });
    await user.click(screen.getByRole('textbox', { name: 'message' }));
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(screen.getByRole('button', { name: 'Permission mode: Accept edits' })).toBe(trigger);
    expect(trigger.dataset.mode).toBe('default');
    expect(trigger.dataset.targetMode).toBe('acceptEdits');
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    // Screen readers hear the target (live region beside the button).
    expect(screen.getByText('Permission mode: Plan')).toBeTruthy();
    await waitFor(() => {
      expect(h.commands('session.setPermissionMode')).toHaveLength(1);
    });
    expect(h.commands('session.setPermissionMode')[0]).toMatchObject({ mode: 'plan' });
    await waitFor(() => {
      expect(trigger.dataset.mode).toBe('plan');
    });
    expect(trigger.dataset.targetMode).toBeUndefined();
    // The focus stayed in the text field.
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'message' }));
  });

  it('cycling back to the actual mode sends nothing', async () => {
    const h = startCycle('idle');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Permission mode: Manual' });
    await user.click(screen.getByRole('textbox', { name: 'message' }));
    // Manual → Accept edits → Plan → Auto → Manual (no bypass for this profile).
    await user.keyboard('{Shift>}{Tab}{Tab}{Tab}{Tab}{/Shift}');
    await new Promise((resolve) => setTimeout(resolve, MODE_CYCLE_SEND_DELAY_MS + 200));
    expect(h.commands('session.setPermissionMode')).toEqual([]);
    expect(
      screen.getByRole('button', { name: 'Permission mode: Manual' }).dataset.targetMode,
    ).toBeUndefined();
  });

  it('cycling back while a switch is on its way still sends the way back', async () => {
    const h = startCycle('idle');
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Permission mode: Manual' });
    // A slow session: the server's answers (ops and acks) wait until released.
    const transport = h.host.transport;
    const deliver = transport.serverSendRaw.bind(transport);
    const held: string[] = [];
    let holding = true;
    transport.serverSendRaw = (text) => {
      if (holding) held.push(text);
      else deliver(text);
    };
    await user.click(screen.getByRole('textbox', { name: 'message' }));
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    await waitFor(() => {
      expect(h.commands('session.setPermissionMode')).toHaveLength(1);
    });
    // Accept edits is on its way; Plan → Auto → Manual: the reported mode, but not the outcome.
    await user.keyboard('{Shift>}{Tab}{Tab}{Tab}{/Shift}');
    await waitFor(() => {
      expect(h.commands('session.setPermissionMode')).toHaveLength(2);
    });
    expect(h.commands('session.setPermissionMode').map((cmd) => cmd.mode)).toEqual([
      'acceptEdits',
      'default',
    ]);
    expect(trigger.dataset.targetMode).toBe('default');
    holding = false;
    act(() => {
      for (const text of held.splice(0)) deliver(text);
    });
    await waitFor(() => {
      expect(trigger.dataset.targetMode).toBeUndefined();
    });
    expect(trigger.dataset.mode).toBe('default');
    expect(screen.getByRole('button', { name: 'Permission mode: Manual' })).toBe(trigger);
  });

  it('bypass is part of the cycle when the profile allows it', async () => {
    const h = startCycle('bypass');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Permission mode: Bypass permissions' });
    await user.click(screen.getByRole('textbox', { name: 'message' }));
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    await waitFor(() => {
      expect(h.commands('session.setPermissionMode')).toEqual([
        { name: 'session.setPermissionMode', entryId: DEMO_ENTRIES.bypass, mode: 'default' },
      ]);
    });
  });

  it('outside the text field and with an open menu Shift+Tab keeps moving the focus', async () => {
    startCycle('idle', true);
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Permission mode: Manual' });
    const field = screen.getByRole('textbox', { name: 'message' });
    await user.click(field);
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).not.toBe(field);
    expect(trigger.dataset.targetMode).toBeUndefined();
    harness?.stop();
    resetClientStore();
    startCycle('idle');
    const second = await screen.findByRole('button', { name: 'Permission mode: Manual' });
    second.focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(second.dataset.targetMode).toBeUndefined();
  });
});

describe('ModelPicker (F.12)', () => {
  it('sets the model, maps "Default" to null and offers effort for models that support it', async () => {
    const h = start('idle', 'model');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Model: Haiku' }));
    await user.click(await screen.findByRole('menuitemradio', { name: /^Sonnet/ }));
    expect(h.commands('session.setModel')).toEqual([
      { name: 'session.setModel', entryId: DEMO_ENTRIES.idle, model: 'sonnet' },
    ]);
    await user.click(await screen.findByRole('button', { name: 'Model: Sonnet' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Extra high' }));
    expect(h.commands('session.setEffort')).toEqual([
      { name: 'session.setEffort', entryId: DEMO_ENTRIES.idle, effort: 'xhigh' },
    ]);
    await user.click(await screen.findByRole('button', { name: 'Model: Sonnet' }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Recommended for most tasks/ }));
    expect(h.commands('session.setModel').at(-1)).toEqual({
      name: 'session.setModel',
      entryId: DEMO_ENTRIES.idle,
      model: null,
    });
  });

  it('shows the fast toggle only for models that offer it', async () => {
    const h = start('idle', 'model');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Model: Haiku' }));
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Fast mode' })).toBeNull();
    await user.keyboard('{Escape}');
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, { modelSetting: 'opus' });
    });
    await user.click(await screen.findByRole('button', { name: 'Model: Opus' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Fast mode' }));
    expect(h.commands('session.setFastMode')).toEqual([
      { name: 'session.setFastMode', entryId: DEMO_ENTRIES.idle, enabled: true },
    ]);
  });

  it('WP22-12: "Default" names the model that actually answers (label and default row)', async () => {
    const h = start('idle', 'model');
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, { modelSetting: null, model: 'claude-haiku-5-5' });
    });
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: /^Model: .+ · claude-haiku-5-5$/ });
    await user.click(trigger);
    expect(await screen.findByText('Currently running on claude-haiku-5-5')).toBeTruthy();
    await user.keyboard('{Escape}');
    // An explicit choice shows just that model.
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, { modelSetting: 'opus' });
    });
    expect(await screen.findByRole('button', { name: 'Model: Opus' })).toBeTruthy();
  });

  it('WP-57: 14 models – aliases first, full ids under "More models" in a scrolling list', async () => {
    const h = start('idle', 'model');
    act(() => {
      h.host.pushOps(DEMO_ENTRIES.idle, [{ op: 'detail.patch', patch: { models: DEMO_MODELS_14 } }]);
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Model: Haiku 5.5' }));
    const list = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="model-list"]');
      if (found === null) throw new Error('no model list');
      return found;
    });
    expect(list.className).toContain('overflow-y-auto');
    const rows = Array.from(list.children).map((child) =>
      child.getAttribute('data-slot') === 'model-more'
        ? '— more —'
        : child.getAttribute('role') === 'separator'
          ? '———'
          : (child.querySelector('.grid')?.firstElementChild?.textContent ?? ''),
    );
    expect(rows).toEqual([
      'Default (recommended)',
      'Opus 5.5',
      'Fable 5.2',
      'Sonnet 5.5',
      'Haiku 5.5',
      '———',
      '— more —',
      'Fable 5.1',
      'Haiku 4.5',
      'Sonnet 5',
      'Opus 5',
      'Fable 5',
      'Opus 4.8',
      'Opus 4.7',
      'Opus 4.6',
      'Sonnet 4.6',
    ]);
    expect(within(list).getByText('More models')).toBeTruthy();
    await user.click(screen.getByRole('menuitemradio', { name: /^Opus 4\.8/ }));
    expect(h.commands('session.setModel').at(-1)).toMatchObject({ model: 'claude-opus-4-8' });
  });

  it('WP-73: "Default" follows the Claude settings – label, sub-line, effort and fast of that row', async () => {
    const h = start('idle', 'model');
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, { modelSetting: null, claudeModel: 'opus', model: null });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Model: Opus' }));
    // The radio stays on Default (choosing Opus would pin the model).
    expect(
      screen.getByRole('menuitemradio', { name: /^Default.*Follows/ }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByText('Follows your Claude settings: Opus')).toBeTruthy();
    expect(screen.queryByText('Recommended for most tasks')).toBeNull();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Fast mode' })).toBeTruthy();
    await user.keyboard('{Escape}');
    // No row for the settings model: opusplan gets its label from i18n; effort/fast of the Default row.
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, { claudeModel: 'opusplan' });
    });
    await user.click(await screen.findByRole('button', { name: 'Model: Opus Plan' }));
    expect(screen.getByText('Follows your Claude settings: Opus Plan')).toBeTruthy();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Fast mode' })).toBeNull();
    await user.keyboard('{Escape}');
    // A pinned model wins over the settings; the Default row still says what choosing it means.
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, { modelSetting: 'sonnet' });
    });
    await user.click(await screen.findByRole('button', { name: 'Model: Sonnet' }));
    expect(screen.getByText('Follows your Claude settings: Opus Plan')).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: /^Sonnet/ }).getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{Escape}');
    // Without a settings model the CLI's own description stays.
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, { claudeModel: null });
    });
    await user.click(await screen.findByRole('button', { name: 'Model: Sonnet' }));
    expect(screen.getByText('Recommended for most tasks')).toBeTruthy();
  });

  it('WP-73: the modelPicker rows form "Your models" (CLI order) before "More models"', async () => {
    const h = start('idle', 'model');
    const models = [
      ...DEMO_MODELS_14.map((model) =>
        model.value === 'claude-opus-4-8' ? { ...model, curated: true } : model,
      ),
      sampleModelOption({ value: 'sonnet[1m]', displayName: 'Sonnet 1M', curated: true }),
    ];
    act(() => {
      h.host.pushOps(DEMO_ENTRIES.idle, [{ op: 'detail.patch', patch: { models } }]);
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Model: Haiku 5.5' }));
    const list = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="model-list"]');
      if (found === null) throw new Error('no model list');
      return found;
    });
    const slot = (child: Element) => child.getAttribute('data-slot');
    const rows = Array.from(list.children).map((child) =>
      slot(child) === 'model-more'
        ? '— more —'
        : slot(child) === 'model-yours'
          ? '— yours —'
          : child.getAttribute('role') === 'separator'
            ? '———'
            : (child.querySelector('.grid')?.firstElementChild?.textContent ?? ''),
    );
    expect(rows.slice(5, 13)).toEqual([
      '———',
      '— yours —',
      'Opus 4.8',
      'Sonnet 1M',
      '———',
      '— more —',
      'Fable 5.1',
      'Haiku 4.5',
    ]);
    expect(rows.filter((row) => row === 'Opus 4.8')).toHaveLength(1);
    expect(within(list).getByText('Your models')).toBeTruthy();
  });

  it('WP-73: every opening reloads the list; an existing list stays in view meanwhile', async () => {
    const h = start('idle', 'model');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Model: Haiku' }));
    expect(await screen.findByRole('menuitemradio', { name: /^Opus/ })).toBeTruthy();
    expect(screen.queryByText('Loading models…')).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: 'Model: Haiku' }));
    await waitFor(() => {
      expect(h.commands('session.refreshModels')).toHaveLength(2);
    });
  });

  it('loads the model list on first open when the detail has none', async () => {
    const h = start('idle', 'model');
    act(() => {
      h.host.pushOps(DEMO_ENTRIES.idle, [{ op: 'detail.patch', patch: { models: null } }]);
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Model: haiku' }));
    expect(h.commands('session.refreshModels')).toEqual([
      { name: 'session.refreshModels', entryId: DEMO_ENTRIES.idle },
    ]);
  });
});

describe('ContextGauge (C.1)', () => {
  // WP-65 §1.6: the WP-63 rule – color by the share of the model window (50/80 %), fill up to the
  // autocompact, the used tokens as text.
  it.each([
    [490_000, 'normal'],
    [500_000, 'warning'],
    [799_000, 'warning'],
    [800_000, 'danger'],
  ] as const)('%i of 1M tokens is %s', async (totalTokens, level) => {
    const h = start('idle', 'gauge');
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, {
        context: sampleContextGauge({ totalTokens, percentage: Math.round(totalTokens / 10_000) }),
      });
    });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="context-gauge"]')?.getAttribute('data-level')).toBe(level);
    });
    expect(screen.getByRole('meter', { name: 'Context' }).getAttribute('aria-valuenow')).toBe(
      String(Math.round(totalTokens / 10_000)),
    );
  });

  it('runs up to the autocompact and shows "autocompact soon" as a symbol (WP-63 rule)', async () => {
    const h = start('idle', 'gauge');
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, {
        context: sampleContextGauge({
          totalTokens: 380_000,
          percentage: 38,
          autoCompactThreshold: 400_000,
          isAutoCompactEnabled: true,
        }),
      });
    });
    await waitFor(() => {
      expect(screen.getByRole('meter', { name: 'Context' }).getAttribute('aria-valuenow')).toBe('95');
    });
    const button = document.querySelector('[data-slot="context-gauge"]');
    expect(button?.getAttribute('data-level')).toBe('normal');
    expect(button?.querySelector('[data-slot="context-compact-soon"]')).not.toBeNull();
    expect(screen.getByRole('meter', { name: 'Context' }).textContent).toBe('380K');
  });

  it('a click loads the breakdown; "Compact now" sends /compact as a prompt', async () => {
    const h = start('idle', 'gauge');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Context 71% – show details' }));
    expect(h.commands('session.getContext')).toEqual([
      { name: 'session.getContext', entryId: DEMO_ENTRIES.idle, detail: 'summary' },
    ]);
    expect(await screen.findByText('System prompt')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Compact now' }));
    expect(h.commands('session.sendPrompt')).toEqual([
      {
        name: 'session.sendPrompt',
        entryId: DEMO_ENTRIES.idle,
        prompt: { text: '/compact', attachments: [], pastes: [] },
        priority: 'next',
      },
    ]);
  });

  it('WP-57: categories go by their stable id (named in the UI language), else by their name', async () => {
    harness = renderWithHost((key) => <ContextGauge sessionKey={key('idle')} />, {
      entries: ['idle'],
      onCommand: (cmd) =>
        cmd.name === 'session.getContext'
          ? {
              ok: true,
              result: {
                context: sampleContextBreakdown({
                  categories: [
                    { name: 'Custom agents (project)', tokens: 1_200, kind: 'used', id: 'custom_agents' },
                    { name: 'Hooks', tokens: 300, kind: 'used', id: 'hooks_future' },
                    { name: 'Messages', tokens: 6_702, kind: 'used', id: null },
                    { name: 'Messages', tokens: 50, kind: 'deferred', id: null },
                  ],
                }),
              },
            }
          : undefined,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Context 71% – show details' }));
    expect(await screen.findByText('Custom agents')).toBeTruthy();
    expect(screen.queryByText('Custom agents (project)')).toBeNull();
    expect(screen.getByText('Hooks')).toBeTruthy();
    const keys = Array.from(document.querySelectorAll('[data-slot="context-categories"] > li')).map((li) =>
      li.getAttribute('data-category'),
    );
    expect(keys).toEqual(['custom_agents', 'hooks_future', 'used:Messages', 'deferred:Messages']);
  });

  it('says so when the breakdown is not available (session not running)', async () => {
    harness = renderWithHost((key) => <ContextGauge sessionKey={key('idle')} />, {
      entries: ['idle'],
      onCommand: (cmd) =>
        cmd.name === 'session.getContext'
          ? { ok: false, error: { code: 'SESSION_NOT_RUNNING', params: {} } }
          : undefined,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Context 71% – show details' }));
    expect(await screen.findByText('The breakdown is available while the session runs.')).toBeTruthy();
  });
});
