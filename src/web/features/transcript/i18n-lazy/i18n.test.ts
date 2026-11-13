/**
 * The lazy transcript namespace (WP-69): German mirrors English (keys, plural forms, placeholders),
 * every key is used by a transcript module, and none of it is part of the static dictionaries.
 */
import { describe, expect, it } from 'vitest';
import { de } from './de';
import { en } from './en';

/** Leaf paths with their kind; plural forms (`{ one, other }`) count as one leaf. */
function leaves(node: unknown, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  if (typeof node !== 'object' || node === null) return result;
  for (const [key, raw] of Object.entries(node)) {
    const value: unknown = raw;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') result.set(path, 'string');
    else if (typeof value === 'object' && value !== null && typeof Reflect.get(value, 'other') === 'string') {
      result.set(path, `plural:${Object.keys(value).sort().join(',')}`);
    } else {
      for (const [child, kind] of leaves(value, path)) result.set(child, kind);
    }
  }
  return result;
}

function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node !== 'object' || node === null) return [];
  return Object.values(node).flatMap(texts);
}

function at(dictionary: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined),
      dictionary,
    );
}

function placeholders(value: unknown): string[] {
  return [
    ...texts(value)
      .join(' ')
      .matchAll(/\{(\w+)\}/g),
  ]
    .map((match) => match[1] ?? '')
    .sort();
}

/** The transcript modules (without tests) and the static dictionaries of the feature. */
const SOURCES = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../i18n-lazy/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('i18n namespace lazy transcript texts (WP-69)', () => {
  it('de has exactly the keys and plural forms of en, no empty texts, the same placeholders', () => {
    expect([...leaves(de)].sort()).toEqual([...leaves(en)].sort());
    for (const text of [...texts(en), ...texts(de)]) expect(text.trim()).not.toBe('');
    for (const path of leaves(en).keys()) {
      expect(placeholders(at(de, path)), path).toEqual(placeholders(at(en, path)));
    }
  });

  it('every key is used by a transcript module (no dead texts)', () => {
    const sources = Object.entries(SOURCES)
      .filter(([file]) => !file.startsWith('../i18n/'))
      .map(([, source]) => source);
    expect(sources.length).toBeGreaterThan(20);
    const unused = [...leaves(en).keys()].filter(
      (path) => !sources.some((source) => source.includes(`'${path}'`)),
    );
    expect(unused).toEqual([]);
  });

  it('the static dictionaries of the feature do not repeat these texts (start-chunk budget)', () => {
    const staticEn = SOURCES['../i18n/en.ts'] ?? '';
    expect(staticEn).not.toBe('');
    for (const text of texts(en)) {
      if (text.length > 12) expect(staticEn.includes(`'${text}'`), text).toBe(false);
    }
  });
});
