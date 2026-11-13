import { useMemo } from 'react';
import { translateFrom, useLanguage, type KeyPaths, type TranslationParams } from '@web/i18n';
import { de } from './de';
import { en } from './en';

/**
 * The lazy namespace of the session info tabs (WP-67): English and German come with the dialog's
 * lazy chunk – none of these texts is part of the start chunk (start-chunk budget). Keys without a
 * namespace prefix: `it('mcp.reconnect')`.
 */
export type InfoKey = KeyPaths<typeof en>;
export type InfoT = (key: InfoKey, params?: TranslationParams) => string;

/** `t` of the session info tabs, bound to the current language (re-renders on a switch). */
export function useInfoT(): InfoT {
  const language = useLanguage();
  return useMemo(() => {
    const dictionary = language === 'de' ? de : en;
    return (key: InfoKey, params?: TranslationParams) => translateFrom(dictionary, en, language, key, params);
  }, [language]);
}
