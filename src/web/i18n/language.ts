import { useSyncExternalStore } from 'react';
import type { Language } from '@shared/common';

/**
 * Current UI language. Start is always English (Plan Punkt 5, no auto-detection); the shell
 * applies `host.state.settings.language` (ShellEffects → setLanguage).
 */
let current: Language = 'en';
const listeners = new Set<() => void>();

export const LANGUAGES: readonly Language[] = ['en', 'de'];
export const DEFAULT_LANGUAGE: Language = 'en';

export function getLanguage(): Language {
  return current;
}

/** Switches the language, sets `<html lang>` and re-renders every `useT()` consumer. */
export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  for (const listener of listeners) listener();
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}
