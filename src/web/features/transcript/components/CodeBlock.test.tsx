import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientStore, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { CodeBlock } from './CodeBlock';

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

describe('transcript CodeBlock (ui/code-block with texts and notices)', () => {
  it('shows the plain title and confirms a copy with a notice', async () => {
    render(
      <TooltipProvider>
        <CodeBlock code="const x = 1;" language={null} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Text')).toBeTruthy();
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('const x = 1;');
    await waitFor(() => {
      expect(notices()).toEqual([[{ text: 'transcript.code.copied' }, 'success']]);
    });
  });

  it('reports a failed copy', async () => {
    render(
      <TooltipProvider>
        <CodeBlock code="x" language={null} bare />
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    setClipboard(undefined);
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    await waitFor(() => {
      expect(notices()).toEqual([[{ text: 'transcript.code.copyFailed' }, 'error']]);
    });
  });
});
