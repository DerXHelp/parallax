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

/** Production code of the web app (tests and playground galleries do not count as use). */
const PRODUCTION = import.meta.glob<string>(
  ['../../../**/*.{ts,tsx}', '!../../../**/*.test.{ts,tsx}', '!../../../playground/**'],
  { query: '?raw', import: 'default', eager: true },
);

/** Source files of the navigation (this namespace's components). */
const NAVIGATION = import.meta.glob<string>(['../*.tsx', '!../*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** `navigation.<path>` appears literally or as the prefix of a template (`navigation.limits.windows.${…}`). */
function used(path: string, sources: readonly string[]): boolean {
  const parts = path.split('.');
  const candidates = [`'navigation.${path}'`, `"navigation.${path}"`, `\`navigation.${path}\``];
  for (let length = 1; length < parts.length; length++) {
    candidates.push(`\`navigation.${parts.slice(0, length).join('.')}.\${`);
  }
  return sources.some((source) => candidates.some((candidate) => source.includes(candidate)));
}

describe('i18n namespace navigation (WP-35)', () => {
  it('de has exactly the keys and plural forms of en, no empty texts, the same placeholders', () => {
    expect([...leaves(de)].sort()).toEqual([...leaves(en)].sort());
    for (const text of [...texts(en), ...texts(de)]) expect(text.trim()).not.toBe('');
    for (const path of leaves(en).keys()) {
      expect(placeholders(at(de, path)), path).toEqual(placeholders(at(en, path)));
    }
  });

  it('every key is used by production code (R4W-20: no dead texts)', () => {
    const sources = Object.values(PRODUCTION);
    expect(sources.length).toBeGreaterThan(50);
    const unused = [...leaves(en).keys()].filter((path) => !used(path, sources));
    expect(unused).toEqual([]);
  });

  it('has no literal text in accessibility attributes of its components', () => {
    expect(Object.keys(NAVIGATION).length).toBeGreaterThan(5);
    for (const [file, source] of Object.entries(NAVIGATION)) {
      expect(source, file).not.toMatch(/\b(?:aria-label|title|placeholder|alt)="[^"]*[A-Za-z]/);
    }
  });
});
