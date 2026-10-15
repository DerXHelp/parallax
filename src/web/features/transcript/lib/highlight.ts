import {
  createCssVariablesTheme,
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { LanguageId } from './languages';
import { SizedLru } from './sized-cache';

/**
 * Syntax highlighting (lazy chunk, only loaded through `import('./highlight')`): `shiki/core` with
 * the JavaScript regex engine – no Oniguruma WebAssembly, so the page CSP needs no
 * `'wasm-unsafe-eval'` (architecture §2.3j, R1-web). One grammar per language, imported on demand.
 * The theme only references CSS variables (`--shiki-token-*`), which the code block maps to the
 * design tokens – the output works in dark and light without re-highlighting.
 */

type GrammarModule = Promise<{ default: LanguageRegistration[] }>;

const GRAMMARS: Readonly<Record<LanguageId, () => GrammarModule>> = {
  bash: () => import('shiki/langs/bash.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
};

const THEME_NAME = 'parallax-css-variables';
const theme = createCssVariablesTheme({ name: THEME_NAME, variablePrefix: '--shiki-', fontStyle: true });

/** One token of a highlighted line: text plus a CSS color (`var(--shiki-token-…)`) and font style. */
export interface HighlightToken {
  content: string;
  color: string | null;
  /** Bit flags of Shiki's FontStyle: 1 italic, 2 bold, 4 underline. */
  fontStyle: number;
}
export type HighlightedLine = readonly HighlightToken[];

let highlighter: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Map<LanguageId, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [theme],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

function loadLanguage(core: HighlighterCore, language: LanguageId): Promise<void> {
  let loading = loadedLanguages.get(language);
  if (loading === undefined) {
    loading = GRAMMARS[language]().then((module) => core.loadLanguage(module.default));
    loadedLanguages.set(language, loading);
    loading.catch(() => loadedLanguages.delete(language));
  }
  return loading;
}

/**
 * Highlighted blocks: at most 200 and ~2 Mi chars (key = the code, the tokens repeat it – counted
 * twice; R2W-18), so a few large files do not pin memory.
 */
const cache = new SizedLru<string, readonly HighlightedLine[]>({ maxEntries: 200, maxSize: 2 * 1024 * 1024 });

function cacheKey(code: string, language: LanguageId): string {
  return `${language}\u0000${code}`;
}

/** Result of an earlier `highlight` call (re-mounted rows of the virtualized list render at once). */
export function peekHighlight(code: string, language: LanguageId): readonly HighlightedLine[] | null {
  return cache.peek(cacheKey(code, language)) ?? null;
}

export async function highlight(code: string, language: LanguageId): Promise<readonly HighlightedLine[]> {
  const key = cacheKey(code, language);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const core = await getHighlighter();
  await loadLanguage(core, language);
  const { tokens } = core.codeToTokens(code, { lang: language, theme: THEME_NAME });
  const lines: HighlightedLine[] = tokens.map((line) =>
    line.map((token) => {
      const fontStyle: number = token.fontStyle ?? 0;
      return { content: token.content, color: token.color ?? null, fontStyle: fontStyle > 0 ? fontStyle : 0 };
    }),
  );
  cache.set(key, lines, key.length * 2);
  return lines;
}
