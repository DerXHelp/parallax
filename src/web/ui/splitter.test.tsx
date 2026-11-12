import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Splitter } from './splitter';

function Controlled({
  onCommit,
  invert = false,
  orientation,
  start = 400,
}: {
  onCommit?: (value: number) => void;
  invert?: boolean;
  orientation?: 'vertical' | 'horizontal';
  start?: number;
}) {
  const [value, setValue] = useState(start);
  return (
    <Splitter
      label="Resize panel"
      valueText={`${String(value)} px`}
      value={value}
      min={320}
      max={700}
      invert={invert}
      orientation={orientation}
      onChange={setValue}
      onCommit={onCommit}
    />
  );
}

describe('Splitter (ui, WP-54)', () => {
  it('is a focusable separator with orientation and value attributes', () => {
    render(<Controlled />);
    const bar = screen.getByRole('separator', { name: 'Resize panel' });
    expect(bar.tabIndex).toBe(0);
    expect(bar.getAttribute('aria-orientation')).toBe('vertical');
    expect(bar.getAttribute('aria-valuenow')).toBe('400');
    expect(bar.getAttribute('aria-valuemin')).toBe('320');
    expect(bar.getAttribute('aria-valuemax')).toBe('700');
    expect(bar.getAttribute('aria-valuetext')).toBe('400 px');
  });

  it('moves ± 16 px with the arrow keys, Home/End jump to min/max, every key commits', async () => {
    const onCommit = vi.fn<(value: number) => void>();
    const user = userEvent.setup();
    render(<Controlled onCommit={onCommit} />);
    const bar = screen.getByRole('separator');
    bar.focus();
    await user.keyboard('{ArrowRight}');
    expect(bar.getAttribute('aria-valuenow')).toBe('416');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(bar.getAttribute('aria-valuenow')).toBe('384');
    await user.keyboard('{Home}');
    expect(bar.getAttribute('aria-valuenow')).toBe('320');
    await user.keyboard('{ArrowLeft}');
    expect(bar.getAttribute('aria-valuenow')).toBe('320');
    await user.keyboard('{End}');
    expect(bar.getAttribute('aria-valuenow')).toBe('700');
    expect(onCommit.mock.calls.map(([value]) => value)).toEqual([416, 400, 384, 320, 320, 700]);
  });

  it('inverts the arrow keys for a pane right of the bar', async () => {
    const user = userEvent.setup();
    render(<Controlled invert />);
    const bar = screen.getByRole('separator');
    bar.focus();
    await user.keyboard('{ArrowLeft}');
    expect(bar.getAttribute('aria-valuenow')).toBe('416');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(bar.getAttribute('aria-valuenow')).toBe('384');
  });

  it('uses up/down for a horizontal bar and ignores other keys', async () => {
    const user = userEvent.setup();
    render(<Controlled orientation="horizontal" />);
    const bar = screen.getByRole('separator');
    expect(bar.getAttribute('aria-orientation')).toBe('horizontal');
    bar.focus();
    await user.keyboard('{ArrowDown}{ArrowRight}x');
    expect(bar.getAttribute('aria-valuenow')).toBe('416');
    await user.keyboard('{ArrowUp}');
    expect(bar.getAttribute('aria-valuenow')).toBe('400');
  });

  it('drags with the pointer (clamped) and commits once on release', () => {
    const onCommit = vi.fn();
    render(<Controlled invert onCommit={onCommit} />);
    const bar = screen.getByRole('separator');
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 500 });
    expect(bar.dataset.dragging).toBe('true');
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 450 });
    expect(bar.getAttribute('aria-valuenow')).toBe('450');
    fireEvent.pointerMove(bar, { pointerId: 2, clientX: 0 });
    expect(bar.getAttribute('aria-valuenow')).toBe('450');
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 0 });
    expect(bar.getAttribute('aria-valuenow')).toBe('700');
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 0 });
    expect(bar.dataset.dragging).toBeUndefined();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(700);
  });

  it('ignores the secondary button', () => {
    render(<Controlled />);
    const bar = screen.getByRole('separator');
    fireEvent.pointerDown(bar, { button: 2, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 600 });
    expect(bar.getAttribute('aria-valuenow')).toBe('400');
  });
});
