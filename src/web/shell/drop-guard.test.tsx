import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { installDropGuard } from './drop-guard';
import { ShellEffects } from './ShellEffects';

interface FakeTransfer {
  types: string[];
  dropEffect: string;
}

/** A `dragover`/`drop` like the browser's (happy-dom has no DataTransfer): bubbling, cancelable. */
function drag(
  type: 'dragover' | 'drop',
  target: Element,
  types: string[],
): { event: Event; transfer: FakeTransfer } {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const transfer: FakeTransfer = { types, dropEffect: 'copy' };
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  target.dispatchEvent(event);
  return { event, transfer };
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

/** An element in the document (inside `parent` or the body). */
function place<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  parent: Element = document.body,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  parent.append(element);
  return element;
}

describe('drop guard (R4W-02)', () => {
  it('refuses a file dropped outside a drop zone: no navigation, no drop cursor', () => {
    const transcript = place('div');
    transcript.dataset.slot = 'transcript';
    const target = place('p', transcript);
    // Without the guard the browser would open the file in the app window.
    expect(drag('drop', target, ['Files']).event.defaultPrevented).toBe(false);
    cleanups.push(installDropGuard(window));
    const over = drag('dragover', target, ['Files']);
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.transfer.dropEffect).toBe('none');
    expect(drag('drop', target, ['Files']).event.defaultPrevented).toBe(true);
  });

  it('leaves drop zones alone (they prevented the default and chose the effect)', () => {
    const zone = place('div');
    const inner = place('span', zone);
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
    });
    cleanups.push(installDropGuard(window));
    const over = drag('dragover', inner, ['Files']);
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.transfer.dropEffect).toBe('copy');
  });

  it('links: refused outside text fields, kept for fields; plain text is never touched', () => {
    const paragraph = place('p');
    const field = place('textarea');
    cleanups.push(installDropGuard(window));
    expect(drag('drop', paragraph, ['text/uri-list', 'text/plain']).event.defaultPrevented).toBe(true);
    expect(drag('drop', field, ['text/uri-list', 'text/plain']).event.defaultPrevented).toBe(false);
    expect(drag('drop', paragraph, ['text/plain']).event.defaultPrevented).toBe(false);
  });

  it('ShellEffects installs it for the window and removes it on unmount', () => {
    const target = place('p');
    const { unmount } = render(<ShellEffects />);
    expect(drag('drop', target, ['Files']).event.defaultPrevented).toBe(true);
    unmount();
    expect(drag('drop', target, ['Files']).event.defaultPrevented).toBe(false);
  });
});
