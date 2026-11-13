import { describe, expect, it } from 'vitest';

/**
 * R5W-01 / ADR-153: the German dictionaries are one lazy chunk, never part of the start chunk. The
 * start chunk is everything main.tsx reaches through static imports – this test walks that graph
 * over the sources (type-only imports are erased by the compiler and do not count) and fails as
 * soon as a German dictionary becomes reachable, e.g. through a new static import in i18n.
 */

const SOURCES = import.meta.glob<string>(['/src/web/**/*.{ts,tsx}', '!/src/web/**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Static runtime imports and re-exports of a module (`import type` / `export type` excluded). */
function staticSpecifiers(source: string): string[] {
  const result: string[] = [];
  const statement = /^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(statement)) {
    if (match[2] !== undefined) continue;
    const specifier = match[4];
    if (specifier !== undefined) result.push(specifier);
  }
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    if (match[1] !== undefined) result.push(match[1]);
  }
  return result;
}

function dirname(file: string): string {
  return file.slice(0, file.lastIndexOf('/'));
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** A source file of src/web for `specifier`, or null (packages, @shared, assets). */
function resolve(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@web/')) base = `/src/web/${specifier.slice('@web/'.length)}`;
  else if (specifier.startsWith('.')) base = normalize(`${dirname(from)}/${specifier}`);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (Object.hasOwn(SOURCES, candidate)) return candidate;
  }
  return null;
}

function startGraph(entry: string): Set<string> {
  const reached = new Set<string>([entry]);
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const specifier of staticSpecifiers(SOURCES[file] ?? '')) {
      const target = resolve(file, specifier);
      if (target !== null && !reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  return reached;
}

const GERMAN = /\/i18n\/(?:de|errors\.de|dictionary\.de)\.ts$/;

/**
 * Lazy namespaces (WP-67): English and German come with a lazy chunk of their own (`translateFrom`)
 * – neither is part of the start chunk nor of dictionary.de.
 */
const LAZY_NAMESPACES = [
  {
    dir: '/src/web/shell/navigation/session-info/i18n/',
    chunk: '/src/web/shell/navigation/session-info/McpTab.tsx',
  },
];

function inLazyNamespace(file: string): boolean {
  return LAZY_NAMESPACES.some((namespace) => file.startsWith(namespace.dir));
}

describe('start chunk (R5W-01, ADR-153)', () => {
  const graph = startGraph('/src/web/main.tsx');

  it('reaches the app and the English dictionaries statically (the walk works)', () => {
    expect(graph.has('/src/web/App.tsx')).toBe(true);
    expect(graph.has('/src/web/i18n/dictionaries.ts')).toBe(true);
    expect(graph.has('/src/web/i18n/en.ts')).toBe(true);
    expect(graph.has('/src/web/features/files/i18n/en.ts')).toBe(true);
    expect(graph.has('/src/web/shell/navigation/i18n/en.ts')).toBe(true);
  });

  it('reaches no German dictionary statically – they come with the lazy chunk dictionary.de.ts', () => {
    const german = [...graph].filter((file) => GERMAN.test(file));
    expect(german).toEqual([]);
    // Every German dictionary of the app is part of that chunk.
    const lazy = startGraph('/src/web/i18n/dictionary.de.ts');
    const all = Object.keys(SOURCES).filter(
      (file) => /\/i18n\/(?:de|errors\.de)\.ts$/.test(file) && !inLazyNamespace(file),
    );
    expect(all.length).toBeGreaterThan(10);
    for (const file of all) expect(lazy.has(file), file).toBe(true);
    expect(SOURCES['/src/web/i18n/dictionaries.ts']).toContain("import('./dictionary.de')");
  });

  it('keeps the lazy namespaces (English and German) out of the start chunk and out of dictionary.de (WP-67)', () => {
    const lazyGerman = startGraph('/src/web/i18n/dictionary.de.ts');
    for (const namespace of LAZY_NAMESPACES) {
      const files = [`${namespace.dir}en.ts`, `${namespace.dir}de.ts`];
      const chunk = startGraph(namespace.chunk);
      for (const file of files) {
        expect(Object.hasOwn(SOURCES, file), file).toBe(true);
        expect(graph.has(file), file).toBe(false);
        expect(lazyGerman.has(file), file).toBe(false);
        expect(chunk.has(file), file).toBe(true);
      }
    }
  });

  it('the i18n core imports no app module outside its dictionaries (an import of lib/storage gave it a start chunk of its own)', () => {
    const core = startGraph('/src/web/i18n/index.ts');
    expect(core.has('/src/web/i18n/language.ts')).toBe(true);
    expect([...core].filter((file) => !file.includes('/i18n/'))).toEqual([]);
  });
});
