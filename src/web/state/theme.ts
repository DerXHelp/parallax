import { useEffect, useSyncExternalStore } from 'react';
import { themeSchema, type Theme } from '@shared/common';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';

/**
 * Theme: Dark (default), Light, System (Plan Punkt 5, ADR-007). Only the class `dark` on `<html>`
 * switches the design tokens of index.css; `color-scheme` follows for native controls. The last
 * setting is cached in localStorage so a reload of a light-themed window does not flash dark.
 */
export type ResolvedTheme = 'dark' | 'light';

export const DEFAULT_THEME: Theme = 'dark';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function resolveTheme(theme: Theme, systemPrefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark ? 'dark' : 'light';
  return theme;
}

export function applyResolvedTheme(
  resolved: ResolvedTheme,
  root: HTMLElement = document.documentElement,
): void {
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}

function mediaQuery(win: Window): MediaQueryList | null {
  return typeof win.matchMedia === 'function' ? win.matchMedia(DARK_QUERY) : null;
}

export function systemPrefersDark(win: Window = window): boolean {
  return mediaQuery(win)?.matches ?? true;
}

export function subscribeSystemTheme(listener: () => void, win: Window = window): () => void {
  const query = mediaQuery(win);
  if (query === null) return () => undefined;
  query.addEventListener('change', listener);
  return () => {
    query.removeEventListener('change', listener);
  };
}

export function readCachedTheme(): Theme | null {
  const parsed = themeSchema.safeParse(readStorage('local', STORAGE_KEYS.theme));
  return parsed.success ? parsed.data : null;
}

/** Before the first render (main.tsx): cached theme or Dark. */
export function applyInitialTheme(win: Window = window): ResolvedTheme {
  const resolved = resolveTheme(readCachedTheme() ?? DEFAULT_THEME, systemPrefersDark(win));
  applyResolvedTheme(resolved, win.document.documentElement);
  return resolved;
}

function subscribeDefault(listener: () => void): () => void {
  return subscribeSystemTheme(listener);
}

function getSystemDark(): boolean {
  return systemPrefersDark();
}

/** `prefers-color-scheme: dark`, live. */
export function useSystemPrefersDark(): boolean {
  return useSyncExternalStore(subscribeDefault, getSystemDark, () => true);
}

/** Applies `theme` to `<html>` (and follows the OS while it is 'system'); returns the resolved theme. */
export function useThemeController(theme: Theme): ResolvedTheme {
  const prefersDark = useSystemPrefersDark();
  const resolved = resolveTheme(theme, prefersDark);
  useEffect(() => {
    applyResolvedTheme(resolved);
  }, [resolved]);
  useEffect(() => {
    writeStorage('local', STORAGE_KEYS.theme, theme);
  }, [theme]);
  return resolved;
}
