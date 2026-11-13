import { useMemo } from 'react';
import { translateFrom, useLanguage, type KeyPaths, type TranslationParams } from '@web/i18n';
import { de } from './de';
import { en } from './en';

/**
 * The lazy namespace of the output style (WP-70): English and German come with the lazy chunks of
 * the output style dialog and the session info – none of these texts is part of the start chunk.
 */
export type StyleKey = KeyPaths<typeof en>;
export type StyleT = (key: StyleKey, params?: TranslationParams) => string;

/** `t` of the output style texts, bound to the current language (re-renders on a switch). */
export function useStyleT(): StyleT {
  const language = useLanguage();
  return useMemo(() => {
    const dictionary = language === 'de' ? de : en;
    return (key: StyleKey, params?: TranslationParams) =>
      translateFrom(dictionary, en, language, key, params);
  }, [language]);
}
