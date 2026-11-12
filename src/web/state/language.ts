import { useEffect } from 'react';
import { languageSchema, type Language } from '@shared/common';
import { DEFAULT_LANGUAGE, preloadLanguage, setLanguage } from '@web/i18n';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';

/**
 * The window language around i18n/language.ts (ADR-153): every language but English is a lazy
 * chunk. The last applied language other than English is cached in localStorage, so the next start
 * fetches its chunk while the window connects – the switch after `host.state` then needs no extra
 * wait (the window still starts in English, as before). Kept out of src/web/i18n on purpose: an
 * import of `lib/storage` there splits the i18n core into a start chunk of its own.
 */

export function readCachedLanguage(): Language | null {
  const parsed = languageSchema.safeParse(readStorage('local', STORAGE_KEYS.language));
  return parsed.success ? parsed.data : null;
}

/** Before the first render (main.tsx): fetch the dictionary of the language used last. */
export function preloadInitialLanguage(): void {
  const cached = readCachedLanguage();
  if (cached !== null && cached !== DEFAULT_LANGUAGE) preloadLanguage(cached);
}

/** English is the default: no key (also no write for a window that never left English). */
function rememberLanguage(language: Language): void {
  const value = language === DEFAULT_LANGUAGE ? null : language;
  if (readStorage('local', STORAGE_KEYS.language) !== value) {
    writeStorage('local', STORAGE_KEYS.language, value);
  }
}

/** Applies `language` to the window (after its dictionary is loaded) and remembers it. */
export function useLanguageController(language: Language): void {
  useEffect(() => {
    rememberLanguage(language);
    setLanguage(language);
  }, [language]);
}
