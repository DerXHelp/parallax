import { describe, expect, it } from 'vitest';
import { translate } from '@web/i18n';
import { de } from './de';
import { en } from './en';

/** Dot paths and texts of every leaf (plural forms count as one leaf per form). */
function leaves(node: unknown, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  if (typeof node !== 'object' || node === null) return result;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') result.set(path, value);
    else for (const [childPath, text] of leaves(value, path)) result.set(childPath, text);
  }
  return result;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

describe('transcript dictionaries', () => {
  const english = leaves(en);
  const german = leaves(de);

  it('have the same keys in English and German', () => {
    expect([...german.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it('have no empty texts and the same placeholders in both languages', () => {
    for (const [path, text] of english) {
      expect(text.trim(), path).not.toBe('');
      const translated = german.get(path) ?? '';
      expect(translated.trim(), path).not.toBe('');
      expect(placeholders(translated), path).toEqual(placeholders(text));
    }
  });

  it('are registered in the i18n core (namespace transcript)', () => {
    expect(translate('en', 'transcript.list.jumpToLatest')).toBe('Jump to latest');
    expect(translate('de', 'transcript.list.jumpToLatest')).toBe('Zu den neuesten');
    expect(translate('de', 'transcript.search.files', { count: 3 })).toBe('3 Dateien');
  });
});
