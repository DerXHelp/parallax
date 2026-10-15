import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_CODES, makeError } from '@shared/errors';
import { DISPLAY_STATUS_KINDS } from '@shared/status';
import { errorsDe } from './errors.de';
import { errorsEn } from './errors.en';
import { DICTIONARIES, getLanguage, setLanguage, t, tError, translate, translateError, useT } from './index';
import { formatDuration, formatNumber, formatPercent, formatRelativeTime } from './format';

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

  it('registers the feature namespaces statically', () => {
    expect(DICTIONARIES.en).toHaveProperty('transcript');
    expect(DICTIONARIES.en).toHaveProperty('decisions');
    expect(DICTIONARIES.en).toHaveProperty('composer');
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
});
