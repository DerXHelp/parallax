import { useMemo } from 'react';
import { translateFrom, useLanguage, type KeyPaths, type TranslationParams } from '@web/i18n';
import { de } from './de';
import { en } from './en';

/**
 * The lazy namespace of the transcript (WP-69): English and German come with the lazy chunks that
 * use them (transcript list, subagent tab) – none of these texts is part of the start chunk.
 */
export type LazyTranscriptKey = KeyPaths<typeof en>;
export type LazyTranscriptT = (key: LazyTranscriptKey, params?: TranslationParams) => string;

/** `t` of the lazy transcript texts, bound to the current language (re-renders on a switch). */
export function useLazyTranscriptT(): LazyTranscriptT {
  const language = useLanguage();
  return useMemo(() => {
    const dictionary = language === 'de' ? de : en;
    return (key: LazyTranscriptKey, params?: TranslationParams) =>
      translateFrom(dictionary, en, language, key, params);
  }, [language]);
}
