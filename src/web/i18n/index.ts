import { useMemo } from 'react';
import type { Language } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import { EN_DICTIONARY, getDictionary, type Dictionary } from './dictionaries';
import * as format from './format';
import { getLanguage, useLanguage } from './language';
import type { KeyPaths, PluralForms, TranslationParams } from './types';

export { EN_DICTIONARY, getDictionary, type Dictionary } from './dictionaries';
export {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  getLanguage,
  getLanguageLoadFailure,
  preloadLanguage,
  setLanguage,
  subscribeLanguage,
  useLanguage,
  useLanguageLoadFailure,
} from './language';
export type { PluralForms, TranslationParams } from './types';

/**
 * i18n core (Plan Punkt 5, architecture §2.3a): typed dictionaries, `t()` with interpolation and
 * plurals, `tError()` for every error code. The dictionaries and their namespaces: dictionaries.ts
 * (English static, every other language one lazy chunk – ADR-153); the current language and the
 * switch: language.ts.
 */

/** Every translatable key, e.g. `'shell.sidebar.label'`, `'status.needs-review'`, `'errors.CWD_NOT_FOUND'`. */
export type TranslationKey = KeyPaths<Dictionary>;

function child(node: unknown, part: string): unknown {
  if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return undefined;
  const value: unknown = Reflect.get(node, part);
  return value;
}

function isPluralForms(value: unknown): value is PluralForms {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'other') === 'string';
}

function lookup(dictionary: Dictionary, key: string): string | PluralForms | undefined {
  let node: unknown = dictionary;
  for (const part of key.split('.')) {
    node = child(node, part);
    if (node === undefined) return undefined;
  }
  if (typeof node === 'string' || isPluralForms(node)) return node;
  return undefined;
}

function pluralText(forms: PluralForms, count: number, language: Language): string {
  const category = format.pluralCategory(count, language);
  const text: unknown = Reflect.get(forms, category);
  return typeof text === 'string' ? text : forms.other;
}

function interpolate(template: string, params: TranslationParams | undefined, language: Language): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.hasOwn(params, name)) return match;
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === 'number' ? format.formatNumber(value, {}, language) : value;
  });
}

/**
 * Text of `key` in `language` (fallback English – also while the language's lazy dictionary is not
 * loaded –, then the key itself). Plural forms pick the category of `params.count`
 * (Intl.PluralRules); `{name}` is replaced by `params.name` (numbers are formatted for the
 * language). Unknown placeholders stay visible.
 */
export function translate(language: Language, key: TranslationKey, params?: TranslationParams): string {
  const value = lookup(getDictionary(language) ?? EN_DICTIONARY, key) ?? lookup(EN_DICTIONARY, key);
  if (value === undefined) return key;
  if (typeof value === 'string') return interpolate(value, params, language);
  const count = params?.count;
  const numeric = typeof count === 'number' ? count : Number(count ?? 0);
  return interpolate(pluralText(value, Number.isFinite(numeric) ? numeric : 0, language), params, language);
}

/** Translates with the current UI language. In components prefer `useT()` (re-renders on change). */
export function t(key: TranslationKey, params?: TranslationParams): string {
  return translate(getLanguage(), key, params);
}

/** Primitive params only (objects/arrays would render as "[object Object]", R1W-15). */
function errorParams(error: ErrorPayload): TranslationParams {
  const result: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(error.params)) {
    if (typeof value === 'number' || typeof value === 'string') result[name] = value;
    else if (typeof value === 'boolean') result[name] = String(value);
  }
  return result;
}

/** Text of an error code (`errors.<CODE>`); every code of @shared/errors has one (tested). */
export function translateError(language: Language, error: ErrorPayload): string {
  return translate(language, `errors.${error.code}`, errorParams(error));
}

export function tError(error: ErrorPayload): string {
  return translateError(getLanguage(), error);
}

/** `t` bound to the current language; the identity changes (and the component re-renders) on a switch. */
export function useT(): typeof t {
  const language = useLanguage();
  return useMemo(
    () => (key: TranslationKey, params?: TranslationParams) => translate(language, key, params),
    [language],
  );
}

/** Formatting helpers of format.ts bound to the current language. */
export interface BoundFormat {
  number(value: number, options?: Intl.NumberFormatOptions): string;
  percent(percent: number): string;
  compact(value: number): string;
  date(value: format.DateInput, options?: Intl.DateTimeFormatOptions): string;
  dateTime(value: format.DateInput): string;
  time(value: format.DateInput): string;
  relative(target: format.DateInput, now: number, style?: Intl.RelativeTimeFormatStyle): string;
  duration(ms: number): string;
  list(items: readonly string[], options?: Intl.ListFormatOptions): string;
}

export interface I18n {
  language: Language;
  t: typeof t;
  tError: typeof tError;
  format: BoundFormat;
}

function bindFormat(language: Language): BoundFormat {
  return {
    number: (value, options) => format.formatNumber(value, options, language),
    percent: (percent) => format.formatPercent(percent, language),
    compact: (value) => format.formatCompactNumber(value, language),
    date: (value, options) => format.formatDate(value, options, language),
    dateTime: (value) => format.formatDateTime(value, language),
    time: (value) => format.formatTime(value, language),
    relative: (target, now, style) => format.formatRelativeTime(target, now, style, language),
    duration: (ms) => format.formatDuration(ms, language),
    list: (items, options) => format.formatList(items, options, language),
  };
}

/** `t`, `tError` and the formatters, all bound to the current language (one memoized object). */
export function useI18n(): I18n {
  const language = useLanguage();
  return useMemo(
    () => ({
      language,
      t: (key: TranslationKey, params?: TranslationParams) => translate(language, key, params),
      tError: (error: ErrorPayload) => translateError(language, error),
      format: bindFormat(language),
    }),
    [language],
  );
}

/** Formatters bound to the current language. */
export function useFormat(): BoundFormat {
  return useI18n().format;
}
