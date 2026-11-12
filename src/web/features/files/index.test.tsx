import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@web/ui/tooltip';
import { FILES_SLOTS } from './index';
import { FILES_SESSION_KEY } from './testing';

// About 1 s alone, but 5–16 s under parallel load (R5W-04): most of it is importing the FileLink
// chunk's module graph (stat cache, actions, menus, the shell's session actions).
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  // Import the chunk's modules up front (cost in the hook): React.lazy still suspends once on the
  // first render, so the plain-text fallback is still checked.
  await import('./FileLink');
}, 120_000);

afterEach(() => {
  cleanup();
});

const README = 'D:\\work\\sample\\README.md';

describe('FILES_SLOTS', () => {
  it('FileLink is lazy: plain text with the default label first, then the link', async () => {
    const { FileLink } = FILES_SLOTS;
    render(
      <TooltipProvider>
        <FileLink sessionKey={FILES_SESSION_KEY} path={README} line={3} />
      </TooltipProvider>,
    );
    const fallback = document.querySelector('[data-slot="file-link"]');
    expect(fallback?.getAttribute('data-state')).toBe('checking');
    expect(fallback?.textContent).toBe('sample\\README.md:3');

    const link = await screen.findByRole('button', { name: 'sample\\README.md:3' }, { timeout: 15_000 });
    expect(link.getAttribute('data-state')).toBe('link');
  });

  it('the menu variant renders nothing while the chunk loads', () => {
    const { FileLink } = FILES_SLOTS;
    const { container } = render(
      <TooltipProvider>
        <FileLink sessionKey={FILES_SESSION_KEY} path={README} variant="menu" />
      </TooltipProvider>,
    );
    expect(container.querySelector('[data-slot="file-link"]')).toBeNull();
  });
});
