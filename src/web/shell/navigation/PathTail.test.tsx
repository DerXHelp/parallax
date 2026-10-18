import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PathTail } from './PathTail';

const LIVE = 'C:\\Users\\me\\AppData\\Local\\Temp\\parallax-live2-20261018-183959\\p1';

function part(container: HTMLElement, slot: 'path-head' | 'path-last'): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
}

describe('PathTail (WP41-02: sessions in sibling folders stay apart)', () => {
  it('the project folder is an element of its own that never shrinks; only the folder before it truncates', () => {
    const { container } = render(<PathTail path={LIVE} data-slot="row-path" className="min-w-10" />);
    const box = container.querySelector<HTMLElement>('[data-slot="row-path"]');
    expect(box?.textContent).toBe('parallax-live2-20261018-183959\\p1');
    // The box itself never cuts its end (it used to be one `truncate` span).
    expect(box?.className.split(' ')).toEqual(expect.arrayContaining(['flex', 'min-w-10']));
    expect(box?.className).not.toContain('truncate');
    const head = part(container, 'path-head');
    expect(head?.textContent).toBe('parallax-live2-20261018-183959');
    expect(head?.className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    const last = part(container, 'path-last');
    expect(last?.textContent).toBe('\\p1');
    // `shrink-0`: the flex box takes the space from the head first; `max-w-full` + `truncate` cut
    // only a folder name wider than the whole box.
    expect(last?.className.split(' ')).toEqual(
      expect.arrayContaining(['shrink-0', 'max-w-full', 'truncate']),
    );
    expect(last?.className).not.toContain('min-w-0');
  });

  it('a tail without a folder before the last one is just the last part', () => {
    const { container } = render(<PathTail path={'D:\\work\\demo'} count={1} />);
    expect(part(container, 'path-head')).toBeNull();
    expect(part(container, 'path-last')?.textContent).toBe('demo');
  });
});
