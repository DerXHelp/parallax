import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@web/ui/tooltip';
import { FILES_SLOTS } from './index';
import { FILES_SESSION_KEY } from './testing';

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

    const link = await screen.findByRole('button', { name: 'sample\\README.md:3' });
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
