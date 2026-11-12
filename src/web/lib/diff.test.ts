import { describe, expect, it } from 'vitest';
import { computeFallbackRows, contentToRows, diffStats, hunksToRows, peekFallbackRows } from './diff';

describe('diff rows', () => {
  it('builds rows with line numbers from structuredPatch hunks', () => {
    const rows = hunksToRows([
      {
        oldStart: 4,
        oldLines: 3,
        newStart: 4,
        newLines: 3,
        lines: [' a', '-b', '+c', ' d', '\\ No newline at end of file'],
      },
    ]);
    expect(rows.map((r) => [r.kind, r.text, r.oldLine, r.newLine])).toEqual([
      ['hunk', '@@ -4,3 +4,3 @@', null, null],
      ['context', 'a', 4, 4],
      ['remove', 'b', 5, null],
      ['add', 'c', null, 5],
      ['context', 'd', 6, 6],
    ]);
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
  });

  it('shows a new file as additions', () => {
    expect(contentToRows('a\r\nb\n').map((r) => [r.kind, r.text, r.newLine])).toEqual([
      ['add', 'a', 1],
      ['add', 'b', 2],
    ]);
    expect(contentToRows('')).toEqual([]);
  });

  it('computes the jsdiff fallback from old_string/new_string and caches it', async () => {
    expect(peekFallbackRows('alpha\nbeta', 'alpha\ngamma')).toBeNull();
    const rows = await computeFallbackRows('alpha\nbeta', 'alpha\ngamma');
    expect(rows.filter((r) => r.kind !== 'hunk').map((r) => `${r.kind}:${r.text}`)).toEqual([
      'context:alpha',
      'remove:beta',
      'add:gamma',
    ]);
    expect(peekFallbackRows('alpha\nbeta', 'alpha\ngamma')).toBe(rows);
  });
});
