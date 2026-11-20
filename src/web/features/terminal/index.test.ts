import { describe, expect, it } from 'vitest';
import { TERMINAL_SLOTS } from './index';

/** index.ts as written (its static imports decide what reaches the start chunk). */
const INDEX = import.meta.glob<string>('./index.ts', { query: '?raw', import: 'default', eager: true })[
  './index.ts'
];

/** Static runtime imports (`import type` is erased and does not count). */
function staticImports(source: string): string[] {
  const result: string[] = [];
  for (const match of source.matchAll(/^\s*import\s+(type\s+)?[^'";]*?\s*from\s*['"]([^'"]+)['"]/gm)) {
    if (match[1] === undefined && match[2] !== undefined) result.push(match[2]);
  }
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    if (match[1] !== undefined) result.push(match[1]);
  }
  return result;
}

describe('TERMINAL_SLOTS (WP-99b)', () => {
  it('fills the slot TerminalPanel', () => {
    expect(TERMINAL_SLOTS.TerminalPanel).toBeTruthy();
  });

  it('keeps xterm, its CSS and the texts in the lazy chunk: index.ts imports only React', () => {
    expect(INDEX).toBeDefined();
    expect(staticImports(INDEX ?? '')).toEqual(['react']);
    expect(INDEX).toContain("lazy(() => import('./TerminalPanel'))");
  });
});
