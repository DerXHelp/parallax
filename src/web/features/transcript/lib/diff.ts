import type { Hunk } from './tool-input';

/**
 * Diff rows for the Edit/Write renderers: hunks from `structuredPatch` (live `tool_use_result`)
 * or – in the history, where `structured` is null (A.3, WP-12 §6) – computed with jsdiff from
 * `old_string`/`new_string`. jsdiff is loaded lazily (`import('diff')`, architecture §2.3j).
 */

export type DiffRowKind = 'context' | 'add' | 'remove' | 'hunk' | 'note';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  /** Line number in the old/new file (null for added/removed lines on the other side, hunks, notes). */
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** Rows of a list of unified-diff hunks (lines prefixed with ' ', '+', '-', '\'). */
export function hunksToRows(hunks: readonly Hunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of hunks) {
    rows.push({
      kind: 'hunk',
      text: `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`,
      oldLine: null,
      newLine: null,
    });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === '+') rows.push({ kind: 'add', text, oldLine: null, newLine: newLine++ });
      else if (marker === '-') rows.push({ kind: 'remove', text, oldLine: oldLine++, newLine: null });
      else if (marker === '\\')
        continue; // "\ No newline at end of file"
      else rows.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return rows;
}

export function diffStats(rows: readonly DiffRow[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'add') added++;
    else if (row.kind === 'remove') removed++;
  }
  return { added, removed };
}

/** A new file: every line is an addition (Write `type:"create"`, F.4 – its patch is empty). */
export function contentToRows(content: string): DiffRow[] {
  if (content === '') return [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((text, index) => ({ kind: 'add', text, oldLine: null, newLine: index + 1 }));
}

const fallbackCache = new Map<string, DiffRow[]>();
const FALLBACK_CACHE_MAX = 100;

function fallbackKey(oldText: string, newText: string): string {
  return `${String(oldText.length)}:${oldText}\u0000${newText}`;
}

/** Cached fallback rows (null until `computeFallbackRows` resolved once for this pair). */
export function peekFallbackRows(oldText: string, newText: string): DiffRow[] | null {
  return fallbackCache.get(fallbackKey(oldText, newText)) ?? null;
}

/**
 * Diff of two snippets (`old_string` → `new_string`) with jsdiff. Line numbers are relative to the
 * snippet (the file position is unknown without `structuredPatch`).
 */
export async function computeFallbackRows(oldText: string, newText: string): Promise<DiffRow[]> {
  const key = fallbackKey(oldText, newText);
  const cached = fallbackCache.get(key);
  if (cached !== undefined) return cached;
  const { structuredPatch } = await import('diff');
  const patch = structuredPatch('a', 'b', oldText, newText, undefined, undefined, { context: 3 });
  const rows = hunksToRows(patch.hunks);
  if (fallbackCache.size >= FALLBACK_CACHE_MAX) {
    const oldest = fallbackCache.keys().next().value;
    if (oldest !== undefined) fallbackCache.delete(oldest);
  }
  fallbackCache.set(key, rows);
  return rows;
}
