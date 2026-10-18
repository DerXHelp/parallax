import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fitScale, Lightbox, type LightboxLabels } from './lightbox';
import { TooltipProvider } from './tooltip';

// Radix dialogs with tooltips: keep a margin under parallel load (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 30_000 });

const LABELS: LightboxLabels = {
  title: 'Image: shot.png',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Fit to window',
  actualSize: 'Actual size',
  save: 'Save as…',
  close: 'Close',
  zoom: (percent) => `${String(percent)} %`,
};

const SRC = '/api/blob/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function renderLightbox() {
  return render(
    <TooltipProvider>
      <Lightbox
        image={{ src: SRC, alt: 'Image: shot.png', downloadName: 'shot.png', width: 400, height: 300 }}
        labels={LABELS}
      >
        <button type="button">open shot.png</button>
      </Lightbox>
    </TooltipProvider>,
  );
}

function zoom(): string | null {
  return document.querySelector('[data-slot="lightbox"]')?.getAttribute('data-zoom') ?? null;
}

describe('Lightbox (WP-37 §8)', () => {
  it('opens from its trigger as a dialog; Esc closes it and the focus returns', async () => {
    renderLightbox();
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'open shot.png' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Image: shot.png' });
    expect(within(dialog).getByRole('img', { name: 'Image: shot.png' }).getAttribute('src')).toBe(SRC);
    // The image area takes the focus (arrow keys scroll; no toolbar tooltip swallows the first Esc).
    expect(document.activeElement?.getAttribute('data-slot')).toBe('lightbox-viewport');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the focus inside while open (focus trap)', async () => {
    renderLightbox();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'open shot.png' }));
    const dialog = await screen.findByRole('dialog');
    for (let i = 0; i < 9; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('"Save as" is a download link with the file name', async () => {
    renderLightbox();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'open shot.png' }));
    const link = await screen.findByRole('link', { name: 'Save as…' });
    expect(link.getAttribute('href')).toBe(SRC);
    expect(link.getAttribute('download')).toBe('shot.png');
  });

  it('zooms with the buttons, the keys + − 0 1 and the mouse wheel', async () => {
    renderLightbox();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'open shot.png' }));
    const dialog = await screen.findByRole('dialog');
    expect(zoom()).toBe('fit');
    expect(within(dialog).getByRole('button', { name: 'Fit to window' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    expect(zoom()).toBe('125');
    expect(dialog.querySelector('[data-slot="lightbox-zoom"]')?.textContent).toBe('125 %');
    expect(dialog.querySelector('img')?.style.width).toBe('500px');
    await user.keyboard('-');
    expect(zoom()).toBe('100');
    await user.keyboard('+');
    expect(zoom()).toBe('125');
    await user.keyboard('0');
    expect(zoom()).toBe('fit');
    await user.keyboard('1');
    expect(zoom()).toBe('100');
    expect(within(dialog).getByRole('button', { name: 'Actual size' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const viewport = dialog.querySelector('[data-slot="lightbox-viewport"]');
    if (viewport === null) throw new Error('no viewport');
    fireEvent.wheel(viewport, { deltaY: -120 });
    expect(zoom()).toBe('125');
    fireEvent.wheel(viewport, { deltaY: 120 });
    fireEvent.wheel(viewport, { deltaY: 120 });
    expect(zoom()).toBe('80');
    await user.click(within(dialog).getByRole('button', { name: 'Zoom out' }));
    expect(zoom()).toBe('64');
  });
});

describe('fitScale', () => {
  it.each([
    [{ width: 400, height: 300 }, { width: 800, height: 600 }, 1],
    [{ width: 1600, height: 900 }, { width: 800, height: 600 }, 0.5],
    [{ width: 1000, height: 2000 }, { width: 800, height: 500 }, 0.25],
    [null, { width: 800, height: 600 }, 1],
    [{ width: 400, height: 300 }, null, 1],
  ])('%j in %j → %d', (natural, box, expected) => {
    expect(fitScale(natural, box)).toBe(expected);
  });
});
