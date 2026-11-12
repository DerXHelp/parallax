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

// The first render loads the module graph: up to 3.9 s under parallel load (R5W-04).
vi.setConfig({ testTimeout: 30_000 });

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

  it('marks the column on the target line and scrolls it into view (R5W-10)', async () => {
    mocks.viewport.size = 400;
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      render(
        <CodeView text={'a\nb\n\tvalue = 1;'} language={null} line={3} col={2} label="Content of a.txt" />,
      );
      const marks = document.querySelectorAll<HTMLElement>('[data-slot="code-column"]');
      expect(marks).toHaveLength(1);
      expect(marks[0]?.closest('[data-line]')?.getAttribute('data-line')).toBe('3');
      // After the tab: the next tab stop (4 ch) behind the left padding.
      expect(marks[0]?.style.left).toBe('calc(0.75rem + 4ch)');
      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
      });
      expect(scrollIntoView.mock.contexts[0]).toBe(marks[0]);
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it('no column mark without a target line or a column', () => {
    mocks.viewport.size = 400;
    const { rerender } = render(<CodeView text={TEXT} language={null} col={3} label="Content of a.txt" />);
    expect(document.querySelector('[data-slot="code-column"]')).toBeNull();
    rerender(<CodeView text={TEXT} language={null} line={5} label="Content of a.txt" />);
    expect(document.querySelector('[data-slot="code-column"]')).toBeNull();
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
