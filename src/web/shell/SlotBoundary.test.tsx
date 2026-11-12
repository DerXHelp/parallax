import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy, Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, SlotBoundary, withSlotBoundary } from './SlotBoundary';

let broken = true;

function Fragile({ label = 'slot content' }: { label?: string }) {
  if (broken) throw new Error('render failed');
  return <p>{label}</p>;
}

beforeEach(() => {
  broken = true;
  // React reports errors caught by a boundary on the console; keep the test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isChunkLoadError', () => {
  it('recognizes failed dynamic imports of Chrome, Firefox, Safari and Vite', () => {
    expect(
      isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://x/a.js')),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: http://x/a.js'))).toBe(
      true,
    );
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/a.css'))).toBe(true);
    const named = new Error('Loading chunk 42 failed.');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error('render failed'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });
});

describe('SlotBoundary (WP-58)', () => {
  it('a render error shows the card, the rest stays; "Reload" tries the slot again', async () => {
    const user = userEvent.setup();
    render(
      <>
        <p>rest of the app</p>
        <SlotBoundary>
          <Fragile />
        </SlotBoundary>
      </>,
    );
    const card = screen.getByRole('alert');
    expect(card.textContent).toContain('This area could not be loaded');
    expect(card.textContent).toContain('Something went wrong while showing it.');
    expect(document.querySelector('[data-slot="slot-error"]')?.getAttribute('data-error-kind')).toBe(
      'render',
    );
    expect(screen.getByText('rest of the app')).toBeTruthy();

    broken = false;
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(screen.getByText('slot content')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a chunk that cannot be loaded asks before reloading the window', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    const Lazy = lazy(() =>
      Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1/x.js')),
    );
    render(
      <SlotBoundary onReloadWindow={reload}>
        <Suspense fallback={null}>
          <Lazy />
        </Suspense>
      </SlotBoundary>,
    );
    const card = await screen.findByRole('alert');
    expect(card.textContent).toContain('A part of the app could not be downloaded');
    expect(document.querySelector('[data-slot="slot-error"]')?.getAttribute('data-error-kind')).toBe('chunk');

    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(screen.getByRole('alert').textContent).toContain('Reload the whole window?');
    // The confirmation takes the focus; "Cancel" goes back without reloading.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reload window' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(reload).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reload' }));

    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await user.click(screen.getByRole('button', { name: 'Reload window' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a new reset key (another session) gives the slot a fresh try', () => {
    const { rerender } = render(
      <SlotBoundary resetKey="a">
        <Fragile />
      </SlotBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    broken = false;
    rerender(
      <SlotBoundary resetKey="a">
        <Fragile />
      </SlotBoundary>,
    );
    // Same key: the card stays.
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(
      <SlotBoundary resetKey="b">
        <Fragile />
      </SlotBoundary>,
    );
    expect(screen.getByText('slot content')).toBeTruthy();
  });

  it('withSlotBoundary wraps a slot component and resets by the chosen prop', () => {
    const Bounded = withSlotBoundary(Fragile, (props) => props.label);
    expect(Bounded.displayName).toBe('SlotBoundary(Fragile)');
    const { rerender } = render(<Bounded label="one" />);
    expect(screen.getByRole('alert')).toBeTruthy();
    broken = false;
    rerender(<Bounded label="two" />);
    expect(screen.getByText('two')).toBeTruthy();
  });
});
