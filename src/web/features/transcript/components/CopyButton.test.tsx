import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientStore, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { CopyButton } from './CopyButton';

afterEach(() => {
  resetClientStore();
});

function notices() {
  return clientStore.getState().notices.map((notice) => [notice.content, notice.tone]);
}

/** user-event installs its own clipboard in `setup()`: replace it afterwards. */
function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

describe('CopyButton (R4W-21: lib/clipboard.copyText)', () => {
  it('copies the text and confirms with a notice', async () => {
    render(
      <TooltipProvider>
        <CopyButton text="const x = 1;" />
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('const x = 1;');
    await waitFor(() => {
      expect(notices()).toEqual([[{ text: 'transcript.code.copied' }, 'success']]);
    });
  });

  it.each([
    ['the write is refused', { writeText: () => Promise.reject(new Error('denied')) }],
    ['there is no clipboard', undefined],
  ])('reports a failure when %s', async (_label, clipboard) => {
    render(
      <TooltipProvider>
        <CopyButton text="x" />
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    setClipboard(clipboard);
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    await waitFor(() => {
      expect(notices()).toEqual([[{ text: 'transcript.code.copyFailed' }, 'error']]);
    });
  });
});
