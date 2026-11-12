import { useSyncExternalStore } from 'react';
import type { Language } from '@shared/common';
import { hasDictionary, loadDictionary } from './dictionaries';

/**
 * Current UI language. Start is always English (Plan Punkt 5, no auto-detection); the shell
 * applies `host.state.settings.language` (ShellEffects → state/language.ts → setLanguage). Every
 * language but English is a lazy chunk (ADR-153): `setLanguage` switches at once when its
 * dictionary is in memory, else it loads the chunk and switches afterwards – until then the window
 * stays English, as it is before `host.state` arrives. A chunk that cannot be loaded keeps English
 * and is reported once per window (`getLanguageLoadFailure`, shown by the shell).
 *
 * No import of `@web/lib/storage` or other app modules here: with one, Rolldown moves the whole
 * i18n core into a start chunk of its own (measured in FIX-R5-F5) – remembering the language for
 * the next start lives in `state/language.ts`.
 */

export const LANGUAGES: readonly Language[] = ['en', 'de'];
export const DEFAULT_LANGUAGE: Language = 'en';

/** Where the dictionaries come from (dictionaries.ts; tests pass their own). */
export interface LanguageSource {
  /** True when the dictionary of `language` is in memory (English always). */
  has(language: Language): boolean;
  /** Fetches the dictionary of `language`; rejects when its chunk cannot be loaded. */
  load(language: Language): Promise<unknown>;
}

export interface LanguageController {
  get(): Language;
  /**
   * Requests `language`: switches synchronously when its dictionary is there, else after loading
   * it. The latest request wins (a switch back to English drops a pending German switch).
   */
  set(language: Language): void;
  subscribe(listener: () => void): () => void;
  /** The language whose dictionary failed first in this window (it stays reported), else null. */
  loadFailure(): Language | null;
}

export function createLanguageController(
  source: LanguageSource,
  onApply?: (language: Language) => void,
): LanguageController {
  let current: Language = DEFAULT_LANGUAGE;
  let requested: Language = DEFAULT_LANGUAGE;
  let failure: Language | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const apply = (language: Language): void => {
    if (language === current) return;
    current = language;
    onApply?.(language);
    notify();
  };

  return {
    get: () => current,
    loadFailure: () => failure,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(language) {
      requested = language;
      if (source.has(language)) {
        apply(language);
        return;
      }
      source.load(language).then(
        () => {
          if (requested === language) apply(language);
        },
        () => {
          // English stays; one report per window (the next request tries the chunk again).
          if (failure !== null) return;
          failure = language;
          notify();
        },
      );
    },
  };
}

const controller = createLanguageController({ has: hasDictionary, load: loadDictionary }, (language) => {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
});

export function getLanguage(): Language {
  return controller.get();
}

/**
 * Switches the language (after loading its dictionary, see above), sets `<html lang>` and
 * re-renders every `useT()` consumer.
 */
export function setLanguage(language: Language): void {
  controller.set(language);
}

export function subscribeLanguage(listener: () => void): () => void {
  return controller.subscribe(listener);
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}

/** The language whose dictionary could not be loaded in this window (first failure), else null. */
export function getLanguageLoadFailure(): Language | null {
  return controller.loadFailure();
}

export function useLanguageLoadFailure(): Language | null {
  return useSyncExternalStore(subscribeLanguage, getLanguageLoadFailure, getLanguageLoadFailure);
}

/**
 * Fetches the dictionary of `language` in the background without switching (ADR-153: at start the
 * language used last, state/language.ts), so the switch after `host.state` needs no extra wait. A
 * failure stays silent here – the switch itself tries again and reports it.
 */
export function preloadLanguage(language: Language): void {
  if (hasDictionary(language)) return;
  loadDictionary(language).catch(() => undefined);
}
