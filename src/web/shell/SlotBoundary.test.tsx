import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy, Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientStore, resetClientStore } from '@web/state/store';
import {
  isChunkLoadError,
  QUIET_SLOT_NOTICE_ID,
  resetQuietSlotFailures,
  SlotBoundary,
  withSlotBoundary,
} from './SlotBoundary';

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
  resetQuietSlotFailures();
  resetClientStore();
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

function InlineFragile({ label }: { label: string }) {
  if (broken) throw new Error('render failed');
  return <a href="#x">{label}</a>;
}

describe('SlotBoundary, quiet variant for running text (R5W-02)', () => {
  it('20 failing inline slots in a paragraph: plain text in place, no card, no div in the p, one notice', () => {
    const Bounded = withSlotBoundary(
      InlineFragile,
      (props) => props.label,
      (props) => <span data-testid="plain">{props.label}</span>,
    );
    const labels = Array.from({ length: 20 }, (_, index) => `file${String(index)}.ts`);
    const { container } = render(
      <p>
        {labels.map((label) => (
          <Bounded key={label} label={label} />
        ))}
      </p>,
    );
    expect(screen.getAllByTestId('plain').map((element) => element.textContent)).toEqual(labels);
    expect(document.querySelector('[data-slot="slot-error"]')).toBeNull();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(container.querySelector('p div')).toBeNull();
    // One loud message for the whole window (rendered by the NotificationCenter as the alert).
    const notices = clientStore.getState().notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      id: QUIET_SLOT_NOTICE_ID,
      tone: 'error',
      content: { text: 'navigation.slotError.inlineRender' },
    });
    expect(notices[0]?.action).toBeUndefined();
  });

  it('a failed chunk: the fallback learns it, the one notice offers "Reload window"; later failures stay silent', async () => {
    const reload = vi.fn();
    const Lazy = lazy(() =>
      Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1/x.js')),
    );
    const quiet = (key: string) => (
      <SlotBoundary
        key={key}
        onReloadWindow={reload}
        fallback={(failure) => <span data-testid="plain">{failure.chunk ? 'chunk' : 'render'}</span>}
      >
        <Suspense fallback={null}>
          <Lazy />
        </Suspense>
      </SlotBoundary>
    );
    const { rerender } = render(<p>{[quiet('a'), quiet('b')]}</p>);
    await waitFor(() => {
      expect(screen.getAllByTestId('plain')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('plain').map((element) => element.textContent)).toEqual(['chunk', 'chunk']);
    const notices = clientStore.getState().notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      content: { text: 'navigation.slotError.inlineChunk' },
      durationMs: null,
    });
    notices[0]?.action?.run();
    expect(reload).toHaveBeenCalledOnce();

    // Dismissed, then more references fail: no second notice in this window.
    resetClientStore();
    rerender(<p>{[quiet('a'), quiet('b'), quiet('c')]}</p>);
    await waitFor(() => {
      expect(screen.getAllByTestId('plain')).toHaveLength(3);
    });
    expect(clientStore.getState().notices).toHaveLength(0);
  });

  it('a new reset key gives a quiet slot a fresh try', () => {
    const Bounded = withSlotBoundary(
      InlineFragile,
      (props) => props.label,
      (props) => <span data-testid="plain">{props.label}</span>,
    );
    const { rerender } = render(<Bounded label="a.ts" />);
    expect(screen.getByTestId('plain').textContent).toBe('a.ts');
    broken = false;
    rerender(<Bounded label="b.ts" />);
    expect(screen.getByRole('link', { name: 'b.ts' })).toBeTruthy();
    expect(screen.queryByTestId('plain')).toBeNull();
  });
});
