import type { DiffRow } from '@web/lib/diff';

/**
 * Rows of a unified patch as the git service sends it (`GitDiffFile.patch`: hunks with their `@@`
 * headers, no `diff --git` header). The hunk row keeps git's whole header line (with the function
 * context after the second `@@`). Lines before the first hunk are ignored, `\ No newline at end of
 * file` too; a trailing CR (a file with CRLF line ends) is not shown. Pure.
 */

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function patchToRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      rows.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
      continue;
    }
    if (!inHunk) continue;
    const marker = line.charAt(0);
    if (marker === '+') rows.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newLine++ });
    else if (marker === '-') {
      rows.push({ kind: 'remove', text: line.slice(1), oldLine: oldLine++, newLine: null });
    } else if (marker !== '\\') {
      // ' ' = context; an empty line is a context line whose blank was stripped on the way.
      rows.push({
        kind: 'context',
        text: marker === ' ' ? line.slice(1) : line,
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }
  return rows;
}

/** A row a comment can sit on (not a hunk header or note). */
export function isLineRow(row: DiffRow): boolean {
  return row.kind === 'add' || row.kind === 'remove' || row.kind === 'context';
}
