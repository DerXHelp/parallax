import { useEffect, useState } from 'react';
import type * as HighlightNamespace from '../lib/highlight';
import type { HighlightedLine } from '../lib/highlight';
import { HIGHLIGHT_MAX_CHARS, type LanguageId } from '../lib/languages';

type HighlightModule = typeof HighlightNamespace;

/** The lazily loaded highlighter module (null until the first code block asked for it). */
let loadedModule: HighlightModule | null = null;
let loadingModule: Promise<HighlightModule> | null = null;

function loadHighlighter(): Promise<HighlightModule> {
  loadingModule ??= import('../lib/highlight').then((module) => {
    loadedModule = module;
    return module;
  });
  return loadingModule;
}

interface Result {
  key: string;
  lines: readonly HighlightedLine[];
}

/**
 * Highlighted lines of a CLOSED code block (B "Shiki läuft nur auf geschlossenen Code-Blöcken"),
 * or null (plain text) while `enabled` is false, for unknown languages, very long code, before the
 * grammar has loaded and when highlighting fails.
 */
export function useHighlight(
  code: string,
  language: LanguageId | null,
  enabled: boolean,
): readonly HighlightedLine[] | null {
  const active = enabled && language !== null && code.length <= HIGHLIGHT_MAX_CHARS && code !== '';
  const key = `${language ?? ''}\u0000${code}`;
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    loadHighlighter()
      .then((module) => module.highlight(code, language))
      .then(
        (lines) => {
          if (!cancelled) setResult({ key, lines });
        },
        () => undefined,
      );
    return () => {
      cancelled = true;
    };
  }, [active, code, language, key]);

  if (!active) return null;
  if (result?.key === key) return result.lines;
  // Re-mounted rows (virtualized list) render highlighted code at once from the module cache.
  return loadedModule?.peekHighlight(code, language) ?? null;
}
