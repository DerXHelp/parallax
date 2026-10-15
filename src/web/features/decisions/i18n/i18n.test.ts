import { describe, expect, it } from 'vitest';
import { de as composerDe } from '../../composer/i18n/de';
import { en as composerEn } from '../../composer/i18n/en';
import { de as decisionsDe } from './de';
import { en as decisionsEn } from './en';

/** Leaf paths with their kind; a namespace object must never look like plural forms. */
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

const NAMESPACES = [
  ['decisions', decisionsEn, decisionsDe],
  ['composer', composerEn, composerDe],
] as const;

describe.each(NAMESPACES)('i18n namespace %s (WP-16)', (_name, en, de) => {
  it('de has exactly the keys and plural forms of en', () => {
    expect([...leaves(de)].sort()).toEqual([...leaves(en)].sort());
  });

  it('has no empty texts and the same placeholders in both languages', () => {
    const enLeaves = leaves(en);
    for (const text of [...texts(en), ...texts(de)]) expect(text.trim()).not.toBe('');
    for (const path of enLeaves.keys()) {
      const get = (dictionary: unknown) =>
        path
          .split('.')
          .reduce<unknown>(
            (node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined),
            dictionary,
          );
      const placeholders = (value: unknown) =>
        [
          ...texts(value)
            .join(' ')
            .matchAll(/\{(\w+)\}/g),
        ]
          .map((m) => m[1])
          .sort();
      expect(placeholders(get(de)), path).toEqual(placeholders(get(en)));
    }
  });

  it('only plural forms use the key "other" (a namespace with it would become a leaf)', () => {
    const categories = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
    for (const [path, kind] of leaves(en)) {
      if (!kind.startsWith('plural:')) continue;
      for (const key of kind.slice('plural:'.length).split(',')) expect(categories.has(key), path).toBe(true);
    }
  });
});
