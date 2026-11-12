import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Language } from '@shared/common';
import { ERROR_CODES, makeError } from '@shared/errors';
import { DISPLAY_STATUS_KINDS } from '@shared/status';
import { deDictionary } from './dictionary.de';
import { errorsDe } from './errors.de';
import { errorsEn } from './errors.en';
import {
  EN_DICTIONARY,
  getDictionary,
  getLanguage,
  getLanguageLoadFailure,
  setLanguage,
  t,
  tError,
  translate,
  translateError,
  useT,
} from './index';
import { createLanguageController, type LanguageSource } from './language';
import { formatDuration, formatList, formatNumber, formatPercent, formatRelativeTime } from './format';

/** Both languages, the German one imported statically here (the app loads it lazily, ADR-153). */
const DICTIONARIES = { en: EN_DICTIONARY, de: deDictionary } as const;

/** Every leaf path with its value kind ('string' or 'plural:<categories>'). */
function leaves(node: unknown, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  if (typeof node !== 'object' || node === null) return result;
  for (const [key, raw] of Object.entries(node)) {
    const value: unknown = raw;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') {
      result.set(path, 'string');
    } else if (
      typeof value === 'object' &&
      value !== null &&
      typeof Reflect.get(value, 'other') === 'string'
    ) {
      result.set(path, `plural:${Object.keys(value).sort().join(',')}`);
    } else {
      for (const [childPath, kind] of leaves(value, path)) result.set(childPath, kind);
    }
  }
  return result;
}

function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node !== 'object' || node === null) return [];
  return Object.values(node).flatMap(texts);
}

afterEach(() => {
  act(() => {
    setLanguage('en');
  });
});

describe('dictionaries', () => {
  it('de has exactly the keys (and plural forms) of en', () => {
    expect([...leaves(DICTIONARIES.de)].sort()).toEqual([...leaves(DICTIONARIES.en)].sort());
  });

  it('has no empty texts', () => {
    for (const language of ['en', 'de'] as const) {
      for (const text of texts(DICTIONARIES[language])) expect(text.trim()).not.toBe('');
    }
  });

  it('translates every error code in both languages', () => {
    expect(Object.keys(errorsEn).sort()).toEqual([...ERROR_CODES].sort());
    expect(Object.keys(errorsDe).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      for (const language of ['en', 'de'] as const) {
        const text = translateError(language, makeError(code));
        expect(text, `${language} ${code}`).not.toBe(`errors.${code}`);
        expect(text).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it('translates every display status (status.<kind>, incl. needs-resume)', () => {
    for (const kind of DISPLAY_STATUS_KINDS) {
      expect(translate('en', `status.${kind}`)).not.toBe(`status.${kind}`);
      expect(translate('de', `status.${kind}`)).not.toBe(`status.${kind}`);
    }
    expect(translate('de', 'status.needs-resume')).toBe('Wartet auf Fortsetzen');
  });

  it('registers every namespace in both languages: English statically, German as the lazy dictionary', () => {
    for (const namespace of [
      'transcript',
      'decisions',
      'composer',
      'files',
      'tasks',
      'sidePanel',
      'errors',
    ]) {
      expect(EN_DICTIONARY).toHaveProperty(namespace);
      expect(deDictionary).toHaveProperty(namespace);
    }
    expect(Object.keys(deDictionary).sort()).toEqual(Object.keys(EN_DICTIONARY).sort());
    expect(getDictionary('en')).toBe(EN_DICTIONARY);
    // Tests run with the German chunk loaded (dictionaries.ts, mode 'test'): the same object.
    expect(getDictionary('de')).toBe(deDictionary);
  });
});

/** A controllable dictionary source: `load` waits until the test settles it. */
function deferredSource(initiallyLoaded: readonly Language[] = ['en']) {
  const loaded = new Set<Language>(initiallyLoaded);
  const requests: { language: Language; resolve: () => void; reject: (error: Error) => void }[] = [];
  const source: LanguageSource = {
    has: (language) => loaded.has(language),
    load: (language) =>
      new Promise<void>((resolve, reject) => {
        requests.push({
          language,
          resolve: () => {
            loaded.add(language);
            resolve();
          },
          reject,
        });
      }),
  };
  return { source, requests };
}

describe('language switch with a lazy dictionary (ADR-153)', () => {
  it('stays English until the dictionary is loaded, then switches and notifies once', async () => {
    const { source, requests } = deferredSource();
    const applied: Language[] = [];
    const controller = createLanguageController(source, (language) => applied.push(language));
    let notified = 0;
    controller.subscribe(() => {
      notified++;
    });
    controller.set('de');
    expect(controller.get()).toBe('en');
    expect(requests.map((request) => request.language)).toEqual(['de']);
    expect(notified).toBe(0);
    requests[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.get()).toBe('de');
    expect(applied).toEqual(['de']);
    expect(notified).toBe(1);
    // Loaded now: back and forth switches synchronously, no new request.
    controller.set('en');
    controller.set('de');
    expect(controller.get()).toBe('de');
    expect(requests).toHaveLength(1);
  });

  it('the latest request wins: a switch back to English drops the pending German switch', async () => {
    const { source, requests } = deferredSource();
    const controller = createLanguageController(source);
    controller.set('de');
    controller.set('en');
    requests[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.get()).toBe('en');
  });

  it('a chunk that cannot be loaded keeps English and is reported once per window', async () => {
    const { source, requests } = deferredSource();
    const controller = createLanguageController(source);
    let notified = 0;
    controller.subscribe(() => {
      notified++;
    });
    controller.set('de');
    requests[0]?.reject(
      new TypeError('Failed to fetch dynamically imported module: /assets/dictionary.de.js'),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.get()).toBe('en');
    expect(controller.loadFailure()).toBe('de');
    expect(notified).toBe(1);
    // The next request tries again; a second failure is not reported again.
    controller.set('de');
    expect(requests).toHaveLength(2);
    requests[1]?.reject(new TypeError('Failed to fetch dynamically imported module'));
    await Promise.resolve();
    await Promise.resolve();
    expect(notified).toBe(1);
    expect(controller.get()).toBe('en');
  });

  it('the app controller: German is in memory in tests, so setLanguage switches synchronously', () => {
    expect(getLanguageLoadFailure()).toBeNull();
    setLanguage('de');
    expect(getLanguage()).toBe('de');
    expect(t('common.close')).toBe('Schließen');
  });
});

describe('t()', () => {
  it('interpolates parameters and formats numbers per language', () => {
    expect(translate('en', 'shell.sidebar.waiting', { count: 1234 })).toBe('Waiting for you (1,234)');
    expect(translate('de', 'shell.sidebar.waiting', { count: 1234 })).toBe('Wartet auf dich (1.234)');
    expect(translate('en', 'shell.notifications.kinds.plan', { title: 'Auth' })).toBe(
      'Auth – plan ready for review',
    );
  });

  it('keeps unknown placeholders visible', () => {
    expect(translate('en', 'shell.notifications.kinds.done')).toBe('{title} – done');
  });

  it('selects plural forms with Intl.PluralRules', () => {
    expect(translate('en', 'shell.sidebar.count', { count: 1 })).toBe('1 session');
    expect(translate('en', 'shell.sidebar.count', { count: 0 })).toBe('0 sessions');
    expect(translate('en', 'shell.sidebar.count', { count: 3 })).toBe('3 sessions');
    expect(translate('de', 'shell.badges.expiredDecisions', { count: 1 })).toBe('1 abgelaufene Entscheidung');
    expect(translate('de', 'shell.badges.expiredDecisions', { count: 2 })).toBe(
      '2 abgelaufene Entscheidungen',
    );
  });

  it('uses the current language; start is English', () => {
    expect(getLanguage()).toBe('en');
    expect(t('common.close')).toBe('Close');
    expect(tError(makeError('CWD_NOT_FOUND'))).toBe('The folder does not exist.');
    setLanguage('de');
    expect(t('common.close')).toBe('Schließen');
    expect(document.documentElement.lang).toBe('de');
  });

  it('useT() re-renders on a language switch', () => {
    function Probe() {
      const tr = useT();
      return <span>{tr('settings.theme')}</span>;
    }
    render(<Probe />);
    expect(screen.getByText('Theme')).toBeTruthy();
    act(() => {
      setLanguage('de');
    });
    expect(screen.getByText('Design')).toBeTruthy();
  });
});

describe('format', () => {
  const now = Date.parse('2026-10-15T08:00:00.000Z');

  it('formats relative times', () => {
    expect(formatRelativeTime(now - 10_000, now, 'long', 'en')).toBe('now');
    expect(formatRelativeTime(now - 2 * 60_000, now, 'long', 'en')).toBe('2 minutes ago');
    expect(formatRelativeTime(now - 2 * 60_000, now, 'long', 'de')).toBe('vor 2 Minuten');
    expect(formatRelativeTime(now + 3 * 3_600_000, now, 'long', 'en')).toBe('in 3 hours');
    expect(formatRelativeTime(now - 26 * 3_600_000, now, 'long', 'en')).toBe('yesterday');
  });

  it('formats numbers, percentages and durations', () => {
    expect(formatNumber(26702, {}, 'en')).toBe('26,702');
    expect(formatNumber(26702, {}, 'de')).toBe('26.702');
    expect(formatPercent(72, 'en')).toBe('72%');
    expect(formatPercent(72, 'de')).toMatch(/^72\s%$/);
    expect(formatDuration(850, 'en')).toContain('850');
    expect(formatDuration(2100, 'de')).toContain('2,1');
    expect(formatDuration(200_000, 'en')).toMatch(/3 min.* 20 sec/);
  });

  it('formats lists in the words of the language (R5W-06)', () => {
    expect(formatList(['txt', 'md', 'pdf'], undefined, 'en')).toBe('txt, md, and pdf');
    expect(formatList(['txt', 'md', 'pdf'], undefined, 'de')).toBe('txt, md und pdf');
    expect(formatList(['txt'], undefined, 'de')).toBe('txt');
  });
});
