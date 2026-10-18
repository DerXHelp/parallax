import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@web/i18n';
import { TooltipProvider } from '@web/ui/tooltip';
import { ShortcutHelp, closeShortcutHelp, openShortcutHelp } from './ShortcutHelp';
import { useShortcut } from './shortcuts';

function InFields() {
  useShortcut({
    id: 'test.inFields',
    keys: 'Mod+Enter',
    description: 'decisions.shortcuts.respond',
    allowInInputs: true,
    run: () => true,
  });
  return null;
}

afterEach(() => {
  act(() => {
    setLanguage('en');
    closeShortcutHelp();
  });
});

describe('ShortcutHelp (R2W-11)', () => {
  it('Esc gives the focus back to where it was (no trigger button – V3-04, R4W-04)', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <textarea aria-label="Message" />
        <ShortcutHelp />
      </TooltipProvider>,
    );
    const field = screen.getByRole('textbox', { name: 'Message' });
    act(() => {
      field.focus();
    });
    act(() => {
      openShortcutHelp();
    });
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(field);
    });
  });

  it('marks shortcuts that also fire in text fields and explains Mod+Enter', () => {
    render(
      <TooltipProvider>
        <ShortcutHelp />
        <InFields />
      </TooltipProvider>,
    );
    act(() => {
      openShortcutHelp();
    });
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog.textContent).toContain('Ctrl+Enter answers only from the fields of the decision bar');
    const marked = [...dialog.querySelectorAll('[data-slot="shortcut-in-inputs"]')];
    expect(marked).toHaveLength(1);
    const row = marked[0]?.closest('div');
    if (!(row instanceof HTMLElement)) throw new Error('no row');
    expect(
      within(row).getByText('Decision bar: answer with the focused button or the main action'),
    ).toBeTruthy();
    expect(within(dialog).getByText('Show keyboard shortcuts')).toBeTruthy();
    act(() => {
      setLanguage('de');
    });
    expect(within(dialog).getByText('auch in Textfeldern')).toBeTruthy();
  });
});
