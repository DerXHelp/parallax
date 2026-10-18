import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@web/ui/dialog';
import { focusElement, focusedElement, useReturnFocus } from './return-focus';

interface HarnessProps {
  withHook: boolean;
  fallback?: () => HTMLElement | null;
  /** Without the hook: called like Radix calls it (the default stays). */
  onCloseAutoFocus?: (event: Event) => void;
}

/** A dialog without a trigger – opened from outside like Ctrl+K or a request (R4W-04). */
function Harness({ withHook, fallback, onCloseAutoFocus }: HarnessProps) {
  const [open, setOpen] = useState(false);
  const returnFocus = useReturnFocus(open, fallback);
  return (
    <>
      <textarea aria-label="Message" />
      <button type="button" data-testid="fallback">
        fallback
      </button>
      {/* Stands in for Ctrl+K: opens without moving the focus. */}
      <button
        type="button"
        data-testid="open"
        tabIndex={-1}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => {
          setOpen(true);
        }}
      >
        open
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onCloseAutoFocus={withHook ? returnFocus : onCloseAutoFocus}>
          <DialogTitle>title</DialogTitle>
          <DialogDescription>description</DialogDescription>
          <input aria-label="Search" />
        </DialogContent>
      </Dialog>
    </>
  );
}

async function openFrom(element: HTMLElement): Promise<void> {
  act(() => {
    element.focus();
  });
  // A click event without a pointer: the focus stays on `element` (like a shortcut).
  act(() => {
    screen.getByTestId('open').click();
  });
  await screen.findByRole('dialog');
}

describe('useReturnFocus (R4W-04, V3-04)', () => {
  it('Esc gives the focus back to the element focused before the dialog opened', async () => {
    render(<Harness withHook />);
    const user = userEvent.setup();
    const message = screen.getByRole('textbox', { name: 'Message' });
    await openFrom(message);
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search' }));
    });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(message);
    });
  });

  it('without the hook Radix leaves the focus on <body> (the bug)', async () => {
    const closed = vi.fn();
    render(<Harness withHook={false} onCloseAutoFocus={closed} />);
    const user = userEvent.setup();
    await openFrom(screen.getByRole('textbox', { name: 'Message' }));
    await user.keyboard('{Escape}');
    // Radix restores the focus right after this handler (its trigger – there is none).
    await waitFor(() => {
      expect(closed).toHaveBeenCalledOnce();
    });
    expect(document.activeElement).toBe(document.body);
  });

  it('falls back when the remembered element is gone (a menu item)', async () => {
    const fallback = () => screen.getByTestId('fallback');
    render(<Harness withHook fallback={fallback} />);
    const user = userEvent.setup();
    const item = document.createElement('button');
    document.body.append(item);
    await openFrom(item);
    item.remove();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('fallback'));
    });
  });

  it('remembers the element of the opening, not the dialog field (StrictMode re-runs effects)', async () => {
    render(
      <StrictMode>
        <Harness withHook />
      </StrictMode>,
    );
    const user = userEvent.setup();
    const message = screen.getByRole('textbox', { name: 'Message' });
    await openFrom(message);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(message);
    });
  });
});

describe('focusElement / focusedElement', () => {
  it('focuses only connected, visible, non-inert elements; body counts as nothing', () => {
    expect(focusedElement()).toBeNull();
    const button = document.createElement('button');
    expect(focusElement(button)).toBe(false);
    document.body.append(button);
    expect(focusElement(button)).toBe(true);
    expect(focusedElement()).toBe(button);
    button.hidden = true;
    expect(focusElement(button)).toBe(false);
    button.hidden = false;
    const inert = document.createElement('div');
    inert.setAttribute('inert', '');
    const inside = document.createElement('button');
    inert.append(inside);
    document.body.append(inert);
    expect(focusElement(inside)).toBe(false);
    expect(focusElement(null)).toBe(false);
    button.remove();
    inert.remove();
  });
});
