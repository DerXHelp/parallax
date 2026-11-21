import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import { sampleGitDiffFile, sampleId, sampleReviewComment, sampleTime } from '@shared/samples';
import { translate } from '@web/i18n';
import { anchorOfRows, anchorUpdate, placeComment, placeComments, shownState, sideLines } from './anchor';
import { buildReviewFeedback, commentLocation, FEEDBACK_QUOTE_LINES, sortComments } from './feedback';
import { patchToRows } from './patch';

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate('en', key, params);

const SAMPLE = sampleGitDiffFile().patch ?? '';

describe('patchToRows (WP-113)', () => {
  it('numbers both sides from the hunk header and keeps the header line', () => {
    const rows = patchToRows(SAMPLE);
    expect(rows.map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([
      ['hunk', null, null],
      ['context', 10, 10],
      ['remove', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['add', null, 13],
      ['context', 12, 14],
    ]);
    expect(rows[0]?.text).toBe('@@ -10,4 +10,5 @@');
    expect(rows[3]?.text).toBe('  if (password.length > 0) {');
  });

  it('keeps the function context, drops CR and "no newline" markers, ignores lines before a hunk', () => {
    const rows = patchToRows(
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ function main() {\r\n-old\r\n+new\r\n\\ No newline at end of file\n \n',
    );
    expect(rows.map((row) => row.kind)).toEqual(['hunk', 'remove', 'add', 'context']);
    expect(rows[0]?.text).toBe('@@ -1,2 +1,2 @@ function main() {');
    expect(rows[1]?.text).toBe('old');
    expect(rows[2]?.text).toBe('new');
    expect(rows[3]).toMatchObject({ text: '', oldLine: 2, newLine: 2 });
  });

  it('numbers a new file from line 1 and several hunks independently', () => {
    const rows = patchToRows('@@ -0,0 +1,2 @@\n+a\n+b\n@@ -40 +41 @@\n-x\n+y\n');
    expect(rows.map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([
      ['hunk', null, null],
      ['add', null, 1],
      ['add', null, 2],
      ['hunk', null, null],
      ['remove', 40, null],
      ['add', null, 41],
    ]);
  });
});

describe('anchors and re-anchoring (WP-113, ADR-254)', () => {
  const rows = patchToRows(SAMPLE);

  it('anchors a range on the new side (added and context lines), only removed lines on the old side', () => {
    expect(anchorOfRows(rows, 3, 4)).toEqual({
      side: 'new',
      line: 11,
      endLine: 12,
      quote: '  if (password.length > 0) {\n    submit();',
    });
    // Backwards and across a removed line: the removed one is not on the new side.
    expect(anchorOfRows(rows, 3, 1)).toMatchObject({ side: 'new', line: 10, endLine: 11 });
    expect(anchorOfRows(rows, 2, 2)).toEqual({ side: 'old', line: 11, endLine: 11, quote: '  submit();' });
    expect(anchorOfRows(rows, 0, 0)).toBeNull();
  });

  it('cuts a long quote at the contract limit', () => {
    const long = patchToRows(`@@ -0,0 +1,1 @@\n+${'x'.repeat(LIMITS.reviewQuoteChars + 10)}\n`);
    expect(anchorOfRows(long, 1, 1)?.quote).toHaveLength(LIMITS.reviewQuoteChars);
  });

  it('keeps a comment in place, finds a moved quote nearest to the old line, else null (stale)', () => {
    const lines = sideLines(rows, 'new');
    expect(
      placeComment(lines, { line: 11, endLine: 12, quote: '  if (password.length > 0) {\n    submit();' }),
    ).toEqual({
      line: 11,
      endLine: 12,
    });
    // The code moved down by 20 lines.
    expect(placeComment(lines, { line: 31, endLine: 31, quote: 'submit();' })).toEqual({
      line: 12,
      endLine: 12,
    });
    expect(placeComment(lines, { line: 11, endLine: 11, quote: 'gone()' })).toBeNull();
    // Without a quote it stays while its last line is in the diff.
    expect(placeComment(lines, { line: 13, endLine: 13, quote: '' })).toEqual({ line: 13, endLine: 13 });
    expect(placeComment(lines, { line: 99, endLine: 99, quote: '' })).toBeNull();
  });

  it('picks the occurrence closest to the stored line', () => {
    const repeated = patchToRows('@@ -0,0 +1,5 @@\n+x();\n+a\n+b\n+c\n+x();\n');
    const lines = sideLines(repeated, 'new');
    expect(placeComment(lines, { line: 4, endLine: 4, quote: 'x();' })).toEqual({ line: 5, endLine: 5 });
    expect(placeComment(lines, { line: 2, endLine: 2, quote: 'x();' })).toEqual({ line: 1, endLine: 1 });
  });

  it('places comments below the row of their last line, the lost ones apart', () => {
    const kept = sampleReviewComment({
      id: sampleId('rc', 1),
      line: 11,
      endLine: 12,
      quote: '  if (password.length > 0) {\n    submit();',
    });
    const old = sampleReviewComment({
      id: sampleId('rc', 2),
      side: 'old',
      line: 11,
      endLine: 11,
      quote: '  submit();',
    });
    const lost = sampleReviewComment({ id: sampleId('rc', 3), quote: 'nowhere' });
    const placed = placeComments(rows, [kept, old, lost]);
    expect(placed.byRow.get(4)).toEqual([kept]);
    expect(placed.byRow.get(2)).toEqual([old]);
    expect(placed.unplaced).toEqual([lost]);
    expect(placed.placements.get(lost.id)).toBeNull();
  });

  it('shows and stores the state of an authoritative diff', () => {
    const open = sampleReviewComment({ line: 11, endLine: 12 });
    const stale = sampleReviewComment({ state: 'stale', line: 11, endLine: 12 });
    expect(shownState(open, null, true)).toBe('stale');
    expect(shownState(open, null, false)).toBe('open');
    expect(shownState(stale, { line: 11, endLine: 12 }, true)).toBe('open');
    expect(anchorUpdate(open, null)).toEqual({ state: 'stale' });
    expect(anchorUpdate(stale, null)).toBeNull();
    expect(anchorUpdate(open, { line: 11, endLine: 12 })).toBeNull();
    expect(anchorUpdate(open, { line: 20, endLine: 21 })).toEqual({ line: 20, endLine: 21 });
    expect(anchorUpdate(stale, { line: 11, endLine: 12 })).toEqual({ state: 'open' });
  });
});

describe('buildReviewFeedback (WP-113, ADR-254)', () => {
  it('numbers the comments in file and line order with place, quote and text', () => {
    const second = sampleReviewComment({
      id: sampleId('rc', 2),
      path: 'src/b.ts',
      line: 3,
      endLine: 3,
      quote: 'const b = 1;',
      text: 'Name it **count**.',
      createdAt: sampleTime(1),
    });
    const first = sampleReviewComment({
      id: sampleId('rc', 1),
      path: 'src/a.ts',
      line: 5,
      endLine: 7,
      quote: 'one\ntwo',
      text: 'Split this.\nAnd test it.',
      createdAt: sampleTime(2),
    });
    const removed = sampleReviewComment({
      id: sampleId('rc', 3),
      path: 'src/a.ts',
      side: 'old',
      line: 2,
      endLine: 2,
      quote: 'gone',
      text: 'Why removed?',
    });
    expect(sortComments([second, removed, first]).map((comment) => comment.id)).toEqual([
      first.id,
      removed.id,
      second.id,
    ]);
    expect(buildReviewFeedback([second, removed, first], t)).toBe(
      [
        'Review comments on the changes (3):',
        '1. src/a.ts:5-7\n   > one\n   > two\n   Split this.\n   And test it.',
        '2. src/a.ts:2 (old version)\n   > gone\n   Why removed?',
        '3. src/b.ts:3\n   > const b = 1;\n   Name it **count**.',
      ].join('\n\n'),
    );
  });

  it('shortens long quotes and is empty without comments', () => {
    const quote = Array.from({ length: 30 }, (_, index) => `line ${String(index)}`).join('\n');
    const text = buildReviewFeedback([sampleReviewComment({ quote, text: 'Long.' })], t);
    expect(text.split('\n').filter((line) => line.startsWith('   > '))).toHaveLength(
      FEEDBACK_QUOTE_LINES + 1,
    );
    expect(text).toContain('   > …');
    expect(buildReviewFeedback([], t)).toBe('');
    expect(commentLocation({ path: 'a.ts', line: 1200, endLine: 1200 })).toBe('a.ts:1200');
  });
});
