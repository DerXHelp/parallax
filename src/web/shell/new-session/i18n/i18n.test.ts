import { describe, expect, it } from 'vitest';
import { de } from './de';
import { en } from './en';

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

function at(dictionary: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), dictionary);
}

function placeholders(value: unknown): string[] {
  return [...texts(value).join(' ').matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

/**
 * Source files of "New session" (this folder and the three shell files of WP-36): UI strings only
 * through t() – also in `aria-label`, `title`, `placeholder` and `alt`, which react/jsx-no-literals
 * does not check (CLAUDE.md "Kein UI-String ohne t()"). Tests are exempt.
 */
const SOURCES = import.meta.glob<string>(
  ['../**/*.tsx', '!../**/*.test.tsx', '../../NewSessionDialog.tsx', '../../NewSessionForm.tsx', '../../EmptyState.tsx'],
  { query: '?raw', import: 'default', eager: true },
);

describe('i18n namespace newSession (WP-36)', () => {
  it('de has exactly the keys and plural forms of en, no empty texts, the same placeholders', () => {
    expect([...leaves(de)].sort()).toEqual([...leaves(en)].sort());
    for (const text of [...texts(en), ...texts(de)]) expect(text.trim()).not.toBe('');
    for (const path of leaves(en).keys()) expect(placeholders(at(de, path)), path).toEqual(placeholders(at(en, path)));
  });

  it('has no literal text in accessibility attributes of its components', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(5);
    for (const [file, source] of Object.entries(SOURCES)) {
      expect(source, file).not.toMatch(/\b(?:aria-label|title|placeholder|alt)="[^"]*[A-Za-z]/);
    }
  });
});
