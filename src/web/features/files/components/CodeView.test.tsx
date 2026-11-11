import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode, Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeView } from './CodeView';

// happy-dom has no layout, and virtua's far scrollToIndex never settles there: a stand-in
// Virtualizer renders every row and exposes a handle whose viewport is measured "later" – like
// Chrome, where virtua's ResizeObserver reports after the jump's layout effect.
const mocks = vi.hoisted(() => ({
  viewport: { size: 0 },
  scrollToIndex: vi.fn<(index: number, options?: { align?: string }) => void>(),
}));

vi.mock('virtua', async () => {
  const { useImperativeHandle } = await import('react');
  function Virtualizer({
    ref,
    data,
    children,
  }: {
    ref?: Ref<unknown>;
    data: readonly string[];
    children: (item: string, index: number) => ReactNode;
  }) {
    useImperativeHandle(ref, () => ({
      get viewportSize() {
        return mocks.viewport.size;
      },
      scrollToIndex: mocks.scrollToIndex,
    }));
    return data.map((item, index) => children(item, index));
  }
  return { Virtualizer };
});

beforeEach(() => {
  mocks.viewport.size = 0;
  mocks.scrollToIndex.mockClear();
});

afterEach(() => {
  cleanup();
});

const TEXT = Array.from({ length: 300 }, (_, index) => `line ${String(index + 1)}`).join('\n');

describe('CodeView line jump', () => {
  it('waits until virtua measured the viewport, then centers the line; marks it and takes the focus', async () => {
    render(<CodeView text={TEXT} language={null} line={250} label="Content of build.log" />);
    expect(document.querySelector('[data-line="250"]')?.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement?.getAttribute('data-slot')).toBe('code-view');
    expect(mocks.scrollToIndex).not.toHaveBeenCalled();

    mocks.viewport.size = 400;
    await waitFor(() => {
      expect(mocks.scrollToIndex).toHaveBeenCalledWith(249, { align: 'center' });
    });
    expect(mocks.scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it('jumps at once when the viewport is known; a line outside the text marks nothing', () => {
    mocks.viewport.size = 400;
    const { rerender } = render(<CodeView text={TEXT} language={null} line={12} label="Content of a.txt" />);
    expect(mocks.scrollToIndex).toHaveBeenCalledWith(11, { align: 'center' });
    rerender(<CodeView text="a\nb" language={null} line={99} label="Content of a.txt" />);
    expect(document.querySelector('[aria-current]')).toBeNull();
    expect(mocks.scrollToIndex).toHaveBeenCalledTimes(1);
  });
});
