import { useMemo } from 'react';
import { translateFrom, useLanguage, type KeyPaths, type TranslationParams } from '@web/i18n';
import { de } from './de';
import { en } from './en';

/**
 * The lazy namespace of the sign-in dialog (WP-70): English and German come with the dialog's lazy
 * chunk – none of these texts is part of the start chunk.
 */
export type LoginKey = KeyPaths<typeof en>;
export type LoginT = (key: LoginKey, params?: TranslationParams) => string;

/** `t` of the sign-in dialog, bound to the current language (re-renders on a switch). */
export function useLoginT(): LoginT {
  const language = useLanguage();
  return useMemo(() => {
    const dictionary = language === 'de' ? de : en;
    return (key: LoginKey, params?: TranslationParams) =>
      translateFrom(dictionary, en, language, key, params);
  }, [language]);
}
