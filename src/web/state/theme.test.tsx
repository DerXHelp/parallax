import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@shared/common';
import { STORAGE_KEYS } from '@web/lib/storage';
import { applyInitialTheme, applyResolvedTheme, resolveTheme, useThemeController } from './theme';

/** Typed stand-in for `matchMedia('(prefers-color-scheme: dark)')` (no cast, R1W-24). */
class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  readonly media = '(prefers-color-scheme: dark)';
  onchange: MediaQueryList['onchange'] = null;
  dark: boolean;

  constructor(dark: boolean) {
    super();
    this.dark = dark;
  }

  get matches(): boolean {
    return this.dark;
  }

  addListener(): void {
    // Deprecated API, unused by theme.ts.
  }

  removeListener(): void {
    // Deprecated API, unused by theme.ts.
  }
}

/** Fake `matchMedia('(prefers-color-scheme: dark)')` that can flip at runtime. */
function stubSystemTheme(initialDark: boolean) {
  const query = new FakeMediaQueryList(initialDark);
  vi.spyOn(window, 'matchMedia').mockImplementation(() => query);
  return {
    set(next: boolean) {
      query.dark = next;
      query.dispatchEvent(new Event('change'));
    },
  };
}

function Probe({ theme }: { theme: Theme }) {
  const resolved = useThemeController(theme);
  return <span data-testid="resolved">{resolved}</span>;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.classList.add('dark');
  window.localStorage.clear();
});

describe('theme', () => {
  it('resolves Dark, Light and System', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('switches only the `dark` class and color-scheme on <html>', () => {
    const root = document.documentElement;
    applyResolvedTheme('light', root);
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.style.colorScheme).toBe('light');
    applyResolvedTheme('dark', root);
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
  });

  it('starts dark by default and from the cached setting otherwise', () => {
    stubSystemTheme(false);
    expect(applyInitialTheme()).toBe('dark');
    window.localStorage.setItem(STORAGE_KEYS.theme, 'light');
    expect(applyInitialTheme()).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('follows the setting and, for System, the OS preference live', () => {
    const system = stubSystemTheme(true);
    const view = render(<Probe theme="light" />);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEYS.theme)).toBe('light');
    view.rerender(<Probe theme="system" />);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    act(() => {
      system.set(false);
    });
    expect(view.getByTestId('resolved').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    view.rerender(<Probe theme="dark" />);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
