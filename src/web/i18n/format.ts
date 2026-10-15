import type { Language } from '@shared/common';
import { getLanguage } from './language';

/**
 * Locale-aware formatting via `Intl` (Plan Punkt 5): numbers, percentages, dates, relative time,
 * durations. Formatters are cached per language and options. Every function takes the language
 * as last optional argument (default: current UI language); `useFormat()` binds it reactively.
 */

const LOCALES: Readonly<Record<Language, string>> = { en: 'en', de: 'de' };

const numberCache = new Map<string, Intl.NumberFormat>();
const dateCache = new Map<string, Intl.DateTimeFormat>();
const relativeCache = new Map<string, Intl.RelativeTimeFormat>();
const pluralCache = new Map<Language, Intl.PluralRules>();

function numberFormat(language: Language, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${language}|${JSON.stringify(options)}`;
  let format = numberCache.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(LOCALES[language], options);
    numberCache.set(key, format);
  }
  return format;
}

function dateFormat(language: Language, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${language}|${JSON.stringify(options)}`;
  let format = dateCache.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(LOCALES[language], options);
    dateCache.set(key, format);
  }
  return format;
}

function relativeFormat(language: Language, style: Intl.RelativeTimeFormatStyle): Intl.RelativeTimeFormat {
  const key = `${language}|${style}`;
  let format = relativeCache.get(key);
  if (format === undefined) {
    format = new Intl.RelativeTimeFormat(LOCALES[language], { numeric: 'auto', style });
    relativeCache.set(key, format);
  }
  return format;
}

/** Plural category of `count` (`one`, `other`, …) for the language. */
export function pluralCategory(count: number, language: Language = getLanguage()): Intl.LDMLPluralRule {
  let rules = pluralCache.get(language);
  if (rules === undefined) {
    rules = new Intl.PluralRules(LOCALES[language]);
    pluralCache.set(language, rules);
  }
  return rules.select(count);
}

export type DateInput = string | number | Date;

function toMs(value: DateInput): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
}

export function formatNumber(
  value: number,
  options: Intl.NumberFormatOptions = {},
  language: Language = getLanguage(),
): string {
  return numberFormat(language, options).format(value);
}

/** `percent` is 0–100 (as in ContextGauge.percentage) → "72 %" / "72%". */
export function formatPercent(percent: number, language: Language = getLanguage()): string {
  return numberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(percent / 100);
}

/** Compact counts, e.g. tokens (`notation: 'compact'`): en 26 702 → "26.7K", 1 000 000 → "1M". */
export function formatCompactNumber(value: number, language: Language = getLanguage()): string {
  return numberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function formatDate(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
  language: Language = getLanguage(),
): string {
  return dateFormat(language, options).format(toMs(value));
}

export function formatDateTime(value: DateInput, language: Language = getLanguage()): string {
  return dateFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(toMs(value));
}

export function formatTime(value: DateInput, language: Language = getLanguage()): string {
  return dateFormat(language, { timeStyle: 'short' }).format(toMs(value));
}

const RELATIVE_STEPS: readonly (readonly [
  limitSeconds: number,
  unit: Intl.RelativeTimeFormatUnit,
  seconds: number,
])[] = [
  [45, 'second', 1],
  [45 * 60, 'minute', 60],
  [22 * 3600, 'hour', 3600],
  [26 * 86_400, 'day', 86_400],
  [320 * 86_400, 'month', 30 * 86_400],
  [Number.POSITIVE_INFINITY, 'year', 365 * 86_400],
];

/**
 * Relative time of `target` against `now` (epoch ms): "now", "2 min. ago", "in 3 hours".
 * Below 45 s the result is "now" (numeric: 'auto'). Pass `now` from `useNow()` (state/clock.ts).
 */
export function formatRelativeTime(
  target: DateInput,
  now: number,
  style: Intl.RelativeTimeFormatStyle = 'long',
  language: Language = getLanguage(),
): string {
  const diffSeconds = (toMs(target) - now) / 1000;
  const abs = Math.abs(diffSeconds);
  const format = relativeFormat(language, style);
  if (abs < 45) return format.format(0, 'second');
  for (const [limit, unit, seconds] of RELATIVE_STEPS) {
    if (abs < limit) return format.format(Math.round(diffSeconds / seconds), unit);
  }
  return format.format(Math.round(diffSeconds / (365 * 86_400)), 'year');
}

/** Duration in ms: "850 ms", "2.1 s", "3 min 20 s", "1 h 5 min" (units via Intl). */
export function formatDuration(ms: number, language: Language = getLanguage()): string {
  const unit = (value: number, name: 'millisecond' | 'second' | 'minute' | 'hour', digits = 0) =>
    numberFormat(language, {
      style: 'unit',
      unit: name,
      unitDisplay: 'short',
      maximumFractionDigits: digits,
    }).format(value);
  const safe = Math.max(0, ms);
  if (safe < 1000) return unit(Math.round(safe), 'millisecond');
  if (safe < 60_000) return unit(safe / 1000, 'second', 1);
  const totalSeconds = Math.round(safe / 1000);
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? unit(minutes, 'minute') : `${unit(minutes, 'minute')} ${unit(seconds, 'second')}`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return minutes === 0 ? unit(hours, 'hour') : `${unit(hours, 'hour')} ${unit(minutes, 'minute')}`;
}
