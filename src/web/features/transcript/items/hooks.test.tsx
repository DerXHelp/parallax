/**
 * WP-69: hook runs in the transcript per `hookDisplay` – a failed run as an error notice ("blocked"
 * for exit code 2, else "failed" with the exit code) with its output to open, a successful one as a
 * quiet line only with "all"; "off" hides every hook row except a failed SessionStart/Setup hook.
 * The row checks the setting itself (nested rows are not filtered by the list).
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookDisplay } from '@shared/model';
import { sampleSystemItems } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { clientStore, resetClientStore } from '@web/state/store';
import { resetExpansion } from '../state/expansion';
import { SystemRow } from './SystemRow';

const KEY = 'local:en_00000000000000000000000000000001';

afterEach(() => {
  setLanguage('en');
  resetClientStore();
  resetExpansion();
});

/** Without host state the window's settings apply (`localSettings`). */
function setDisplay(hookDisplay: HookDisplay): void {
  act(() => {
    clientStore.setState((state) => ({ localSettings: { ...state.localSettings, hookDisplay } }));
  });
}

const ok = sampleSystemItems.hook({ id: 'h-ok', hookName: 'PostToolUse:Read', outcome: 'success', exitCode: 0 });
const blocked = sampleSystemItems.hook({
  id: 'h-block',
  hookName: 'PreToolUse:Write',
  hookEvent: 'PreToolUse',
  outcome: 'error',
  exitCode: 2,
  output: { text: 'Writing is blocked in this project\n', truncated: null },
});
const failed = sampleSystemItems.hook({ id: 'h-fail', hookName: 'Stop', hookEvent: 'Stop', outcome: 'error', exitCode: 1 });
const startFailed = sampleSystemItems.hook({
  id: 'h-start',
  hookName: 'SessionStart:startup',
  hookEvent: 'SessionStart',
  outcome: 'error',
  exitCode: null,
});

describe('hook rows (WP-69)', () => {
  it('failed (default): the blocking run as an error with its output to open; a successful one hidden', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<SystemRow item={blocked} sessionKey={KEY} />);
    const notice = container.querySelector<HTMLElement>('[data-slot="hook-failed"]');
    expect(notice?.textContent).toContain('Hook PreToolUse blocked Write');
    expect(notice?.querySelector('[data-tone="error"]')).not.toBeNull();
    expect(screen.queryByText(/Writing is blocked/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Output' }));
    expect(screen.getByText(/Writing is blocked in this project/)).toBeTruthy();
    rerender(<SystemRow item={failed} sessionKey={KEY} />);
    expect(container.textContent).toContain('Hook Stop failed (exit code 1)');
    rerender(<SystemRow item={ok} sessionKey={KEY} />);
    expect(container.textContent).toBe('');
  });

  it('all: a successful run is a quiet line; off: nothing but a failed start hook', () => {
    setDisplay('all');
    const { container, rerender } = render(<SystemRow item={ok} sessionKey={KEY} />);
    expect(container.querySelector('[data-slot="hook"]')?.textContent).toContain('Hook PostToolUse:Read');
    setDisplay('off');
    expect(container.textContent).toBe('');
    rerender(<SystemRow item={blocked} sessionKey={KEY} />);
    expect(container.textContent).toBe('');
    rerender(<SystemRow item={startFailed} sessionKey={KEY} />);
    expect(container.textContent).toContain('Hook SessionStart:startup failed');
  });

  it('German texts', () => {
    act(() => {
      setLanguage('de');
    });
    const { container } = render(<SystemRow item={blocked} sessionKey={KEY} />);
    expect(container.textContent).toContain('Hook PreToolUse hat Write blockiert');
  });
});
