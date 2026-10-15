import { useMemo } from 'react';
import type { Language } from '@shared/common';
import { useLanguage } from '@web/i18n';
import { formatNumber, pluralCategory } from '@web/i18n/format';
import type { KeyPaths, PluralForms, TranslationParams } from '@web/i18n/types';
import { de } from './de';
import { en } from './en';

/**
 * Texts of "Stop server" with the rules of `translate` (src/web/i18n/index.ts): English fallback,
 * `{name}` placeholders (numbers formatted for the language), plural forms by `params.count`.
 *
 * Interim: new namespaces are registered by the coordinator in src/web/i18n/index.ts (read-only for
 * this package). Once `serverShutdown` is registered there, callers switch to
 * `t('serverShutdown.<key>')` and this lookup goes away – keys and dictionaries stay as they are.
 */
const DICTIONARIES: Readonly<Record<Language, typeof en>> = { en, de };

export type ShutdownTextKey = KeyPaths<typeof en>;
export type ShutdownT = (key: ShutdownTextKey, params?: TranslationParams) => string;

function isPluralForms(value: unknown): value is PluralForms {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'other') === 'string';
}

function lookup(dictionary: typeof en, key: string): string | PluralForms | undefined {
  let node: unknown = dictionary;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return undefined;
    node = Reflect.get(node, part);
  }
  return typeof node === 'string' || isPluralForms(node) ? node : undefined;
}

export function translateShutdown(
  language: Language,
  key: ShutdownTextKey,
  params?: TranslationParams,
): string {
  const value = lookup(DICTIONARIES[language], key) ?? lookup(en, key);
  if (value === undefined) return key;
  let template: string;
  if (typeof value === 'string') {
    template = value;
  } else {
    const count = Number(params?.count ?? 0);
    const text: unknown = Reflect.get(value, pluralCategory(Number.isFinite(count) ? count : 0, language));
    template = typeof text === 'string' ? text : value.other;
  }
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const param = Object.hasOwn(params, name) ? params[name] : undefined;
    if (param === undefined) return match;
    return typeof param === 'number' ? formatNumber(param, {}, language) : param;
  });
}

/** `translateShutdown` bound to the current UI language (re-renders on a language switch). */
export function useShutdownT(): ShutdownT {
  const language = useLanguage();
  return useMemo(() => (key, params) => translateShutdown(language, key, params), [language]);
}
