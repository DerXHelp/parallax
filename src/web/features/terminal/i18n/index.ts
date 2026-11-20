import { useMemo } from 'react';
import { translateFrom, useLanguage, type KeyPaths, type TranslationParams } from '@web/i18n';
import { de } from './de';
import { en } from './en';

/**
 * The lazy namespace of the embedded terminal (WP-99b): English and German come with the panel's
 * lazy chunk – none of these texts is part of the start chunk. Keys without a namespace prefix:
 * `tt('menu.copy')`.
 */
export type TerminalKey = KeyPaths<typeof en>;
export type TerminalT = (key: TerminalKey, params?: TranslationParams) => string;

/** `t` of the terminal texts, bound to the current language (re-renders on a switch). */
export function useTerminalT(): TerminalT {
  const language = useLanguage();
  return useMemo(() => {
    const dictionary = language === 'de' ? de : en;
    return (key: TerminalKey, params?: TranslationParams) =>
      translateFrom(dictionary, en, language, key, params);
  }, [language]);
}
