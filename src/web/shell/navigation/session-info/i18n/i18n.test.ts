import { describe, expect, it } from 'vitest';
import { translateFrom } from '@web/i18n';
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

/** The components of this namespace: the tabs and the dialog around them. */
const SOURCES = import.meta.glob<string>(
  ['../*.{ts,tsx}', '!../*.test.{ts,tsx}', '../../SessionInfoDialog.tsx'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

/** `<path>` appears literally or as the prefix of a template (`mcp.done.${…}`). */
function used(path: string, sources: readonly string[]): boolean {
  const parts = path.split('.');
  const candidates = [`'${path}'`, `"${path}"`, `\`${path}\``];
  for (let length = 1; length < parts.length; length++) {
    candidates.push(`\`${parts.slice(0, length).join('.')}.\${`);
  }
  return sources.some((source) => candidates.some((candidate) => source.includes(candidate)));
}

describe('i18n namespace session info (WP-67, lazy)', () => {
  it('de has exactly the keys and plural forms of en, no empty texts, the same placeholders', () => {
    expect([...leaves(de)].sort()).toEqual([...leaves(en)].sort());
    for (const text of [...texts(en), ...texts(de)]) expect(text.trim()).not.toBe('');
    for (const path of leaves(en).keys()) {
      expect(placeholders(at(de, path)), path).toEqual(placeholders(at(en, path)));
    }
  });

  it('every key is used by the tabs or the dialog (no dead texts)', () => {
    const sources = Object.values(SOURCES);
    expect(sources.length).toBeGreaterThan(8);
    const unused = [...leaves(en).keys()].filter((path) => !used(path, sources));
    expect(unused).toEqual([]);
  });

  it('has no literal text in accessibility attributes of its components', () => {
    for (const [file, source] of Object.entries(SOURCES)) {
      expect(source, file).not.toMatch(/\b(?:aria-label|title|placeholder|alt)="[^"]*[A-Za-z]/);
    }
  });

  it('translateFrom: the language, the English fallback, plurals and placeholders', () => {
    expect(translateFrom(de, en, 'de', 'mcp.reconnect')).toBe(de.mcp.reconnect);
    expect(translateFrom(en, en, 'en', 'mcp.done.disable', { name: 'fake-docs' })).toBe(
      'fake-docs turned off.',
    );
    expect(translateFrom(en, en, 'en', 'mcp.tools', { count: 1 })).toBe('1 tool');
    expect(translateFrom(en, en, 'en', 'mcp.tools', { count: 3 })).toBe('3 tools');
    // A key missing in the language falls back to English, then to the key itself.
    const partial = { ...de, state: { ...de.state } };
    Reflect.deleteProperty(partial.state, 'start');
    expect(translateFrom(partial, en, 'de', 'state.start')).toBe(en.state.start);
    const bare = { ...en, state: { ...en.state } };
    Reflect.deleteProperty(bare.state, 'start');
    expect(translateFrom(bare, bare, 'en', 'state.start')).toBe('state.start');
  });
});
