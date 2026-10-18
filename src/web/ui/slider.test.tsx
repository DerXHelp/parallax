import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Slider } from './slider';

function Controlled({
  onCommit,
  disabled = false,
}: {
  onCommit: (value: number[]) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState([60]);
  return (
    <Slider
      thumbLabel="Volume"
      valueText={(v) => `${String(v)} %`}
      value={value}
      onValueChange={setValue}
      onValueCommit={onCommit}
      disabled={disabled}
    />
  );
}

describe('Slider (Radix, WP-38)', () => {
  it('names the thumb and speaks the value text', () => {
    render(<Controlled onCommit={() => undefined} />);
    const thumb = screen.getByRole('slider', { name: 'Volume' });
    expect(thumb.getAttribute('aria-valuenow')).toBe('60');
    expect(thumb.getAttribute('aria-valuemin')).toBe('0');
    expect(thumb.getAttribute('aria-valuemax')).toBe('100');
    expect(thumb.getAttribute('aria-valuetext')).toBe('60 %');
  });

  it('steps with the keyboard and commits every key step', async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<Controlled onCommit={onCommit} />);
    const thumb = screen.getByRole('slider', { name: 'Volume' });
    thumb.focus();
    await user.keyboard('{ArrowRight}');
    expect(thumb.getAttribute('aria-valuenow')).toBe('61');
    expect(onCommit).toHaveBeenLastCalledWith([61]);
    await user.keyboard('{PageDown}');
    expect(onCommit).toHaveBeenLastCalledWith([51]);
    await user.keyboard('{Home}');
    expect(onCommit).toHaveBeenLastCalledWith([0]);
    await user.keyboard('{End}');
    expect(thumb.getAttribute('aria-valuetext')).toBe('100 %');
    expect(onCommit).toHaveBeenLastCalledWith([100]);
  });

  it('a disabled slider does not move', async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<Controlled onCommit={onCommit} disabled />);
    const thumb = screen.getByRole('slider', { name: 'Volume' });
    thumb.focus();
    await user.keyboard('{ArrowRight}');
    expect(thumb.getAttribute('aria-valuenow')).toBe('60');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
