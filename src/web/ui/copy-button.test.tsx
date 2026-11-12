import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CopyButton } from './copy-button';
import { TooltipProvider } from './tooltip';

/** user-event installs its own clipboard in `setup()`: replace it afterwards. */
function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

describe('CopyButton (R4W-21: lib/clipboard.copyText)', () => {
  it('copies the text and reports success', async () => {
    const onCopied = vi.fn();
    render(
      <TooltipProvider>
        <CopyButton text="const x = 1;" label="Copy it" onCopied={onCopied} />
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    await user.click(screen.getByRole('button', { name: 'Copy it' }));
    expect(writeText).toHaveBeenCalledWith('const x = 1;');
    await waitFor(() => {
      expect(onCopied).toHaveBeenCalledWith(true);
    });
  });

  it.each([
    ['the write is refused', { writeText: () => Promise.reject(new Error('denied')) }],
    ['there is no clipboard', undefined],
  ])('reports a failure when %s', async (_label, clipboard) => {
    const onCopied = vi.fn();
    render(
      <TooltipProvider>
        <CopyButton text="x" label="Copy it" onCopied={onCopied} />
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    setClipboard(clipboard);
    await user.click(screen.getByRole('button', { name: 'Copy it' }));
    await waitFor(() => {
      expect(onCopied).toHaveBeenCalledWith(false);
    });
  });
});
