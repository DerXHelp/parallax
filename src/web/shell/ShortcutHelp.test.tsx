import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@web/i18n';
import { TooltipProvider } from '@web/ui/tooltip';
import { ShortcutHelp, openShortcutHelp } from './ShortcutHelp';
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
  });
});

describe('ShortcutHelp (R2W-11)', () => {
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
