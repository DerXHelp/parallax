import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleExternalHandoff } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { formatTime } from '@web/i18n/format';
import { refreshClock } from '@web/state/clock';
import { resetClientStore } from '@web/state/store';
import { DecisionBar } from '../decisions/DecisionBar';
import { DEMO_ENTRIES, type DemoEntry } from '../decisions/lib/demo-data';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { resetDecisionBarState } from '../decisions/state/bar-store';
import { Composer } from './Composer';
import { resetDraftStore } from './state/drafts';

vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  vi.useRealTimers();
  resetClientStore();
  resetDecisionBarState();
  resetDraftStore();
  localStorage.clear();
});

type OnCommand = Parameters<typeof renderWithHost>[1]['onCommand'];

function start(entry: DemoEntry = 'idle', onCommand?: OnCommand, bar = false): Harness {
  harness = renderWithHost(
    (key) => (
      <>
        {bar ? <DecisionBar sessionKey={key(entry)} /> : null}
        <Composer sessionKey={key(entry)} />
      </>
    ),
    { entries: [entry], onCommand },
  );
  return harness;
}

function textbox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Claude' });
}

describe('prompt suggestion as ghost text (ADR-117)', () => {
  it('an empty field shows the suggestion; Tab takes it, with text Tab leaves the field', async () => {
    const h = start();
    await screen.findByRole('button', { name: 'Model: Haiku' });
    expect(textbox().placeholder).toBe('Message Claude…');
    act(() => {
      h.host.pushOps(DEMO_ENTRIES.idle, [
        { op: 'detail.patch', patch: { promptSuggestion: 'Run the tests now' } },
      ]);
    });
    expect(textbox().placeholder).toBe('Run the tests now');
    expect(textbox().getAttribute('aria-describedby')).toContain('suggestion');
    expect(screen.getByText('Suggestion: press Tab to take it.')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(textbox());
    await user.keyboard('{Tab}');
    expect(textbox().value).toBe('Run the tests now');
    expect(document.activeElement).toBe(textbox());
    await user.keyboard('{Tab}');
    expect(textbox().value).toBe('Run the tests now');
    expect(document.activeElement).not.toBe(textbox());
  });

  it('a decision the field answers keeps its own placeholder', async () => {
    const h = start('permission', undefined, true);
    await screen.findByRole('button', { name: 'Model: Haiku' });
    act(() => {
      h.host.pushOps(DEMO_ENTRIES.permission, [
        { op: 'detail.patch', patch: { promptSuggestion: 'Run the tests now' } },
      ]);
    });
    expect(textbox().placeholder).toBe('Tell Claude what to do instead…');
  });
});

describe('rate-limit banner (ADR-112)', () => {
  const NOW = Date.parse('2026-10-16T12:00:00.000Z');
  const RESET = '2026-10-16T12:00:05.000Z';

  function limited(h: Harness, wakeupAt: string | null = null) {
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, {}, { rateLimitedUntil: RESET, wakeupAt });
    });
  }

  function banner(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[data-slot="rate-limit-banner"]');
    if (element === null) throw new Error('no banner');
    return element;
  }

  it('limited → "Continue at HH:MM" plans; planned → "Cancel"; after the reset "Continue" right away', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    refreshClock();
    const h = start('idle', (cmd, host) => {
      if (cmd.name !== 'session.continueAfterLimit') return undefined;
      const at = cmd.enabled ? RESET : null;
      host.patchSummary(cmd.entryId, {}, { wakeupAt: at });
      return { ok: true, result: { continueAt: at } };
    });
    expect(document.querySelector('[data-slot="rate-limit-banner"]')).toBeNull();
    limited(h);
    const time = formatTime(RESET, 'en');
    expect(banner().getAttribute('data-state')).toBe('limited');
    expect(banner().textContent).toContain(`Usage limit reached – resets at ${time}`);
    const user = userEvent.setup();
    await user.click(within(banner()).getByRole('button', { name: `Continue at ${time}` }));
    await waitFor(() => {
      expect(banner().getAttribute('data-state')).toBe('scheduled');
    });
    expect(banner().textContent).toContain(`Continue planned at ${time}`);
    await user.click(within(banner()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(banner().getAttribute('data-state')).toBe('limited');
    });
    // The reset passes: the clock re-renders the banner at its deadline.
    act(() => {
      vi.setSystemTime(NOW + 6000);
      refreshClock();
    });
    expect(banner().getAttribute('data-state')).toBe('expired');
    expect(banner().textContent).toContain('The usage limit has been reset.');
    await user.click(within(banner()).getByRole('button', { name: 'Continue' }));
    expect(h.commands('session.continueAfterLimit').map((cmd) => cmd.enabled)).toEqual([true, false, true]);
  });

  it('a planned continue shows from the start; German texts', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    refreshClock();
    setLanguage('de');
    try {
      const h = start();
      limited(h, RESET);
      expect(banner().getAttribute('data-state')).toBe('scheduled');
      expect(banner().textContent).toContain(`Fortsetzen geplant um ${formatTime(RESET, 'de')}`);
      expect(within(banner()).getByRole('button', { name: 'Abbrechen' })).toBeTruthy();
    } finally {
      act(() => {
        setLanguage('en');
      });
    }
  });
});

describe('disabled composer (WP-37 §7)', () => {
  it('archived or handed off: no field, one short line; the draft comes back afterwards', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.type(textbox(), 'half a thought');
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, { archived: true });
    });
    expect(screen.queryByRole('textbox')).toBeNull();
    const composer = document.querySelector('[data-slot="composer"]');
    expect(composer?.getAttribute('data-mode')).toBe('disabled');
    expect(composer?.textContent).toBe('Archived – read only.');
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, {
        archived: false,
        external: { since: sampleExternalHandoff().since, pid: 52_000, running: true },
      });
    });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('[data-slot="composer"]')?.textContent).toBe(
      'Open in an external console – take it back to write here.',
    );
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, { external: null });
    });
    expect(textbox().value).toBe('half a thought');
  });
});
