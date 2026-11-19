import { describe, expect, it } from 'vitest';
import type { PlanAnnotation } from '@shared/model';
import { samplePlanAnnotation } from '@shared/samples';
import { translate, type TranslationKey, type TranslationParams } from '@web/i18n';
import { headingOf, splitPlanBlocks } from './plan-blocks';
import { plainInline } from './plain-text';
import {
  buildPlanFeedback,
  FEEDBACK_QUOTE_CHARS,
  feedbackOverhead,
  joinPlanFeedback,
  planFeedbackSection,
  sortAnnotations,
} from './plan-feedback';
import { findQuote, quoteAt, rangeOfSpan, spanOfRange } from './text-anchor';

const t = (key: TranslationKey, params?: TranslationParams) => translate('en', key, params);

const PLAN = [
  '# Plan: Zoom', // 1
  '', // 2
  'Intro with **bold** text.', // 3
  '', // 4
  '## Part A', // 5
  '', // 6
  '1. First step', // 7
  '   - nested detail', // 8
  '', // 9
  '2. Second step', // 10
  '   ```ts', // 11
  '   const a = 1;', // 12
  '', // 13
  '   3. not an item', // 14
  '   ```', // 15
  '', // 16
  '### Part A.1', // 17
  'Text right below.', // 18
  '', // 19
  '## Part B', // 20
  '- one', // 21
  '- two', // 22
].join('\n');

describe('splitPlanBlocks (WP-93)', () => {
  it('splits lists into top-level items, keeps fences whole, numbers lines and heading paths', () => {
    const blocks = splitPlanBlocks(PLAN);
    expect(blocks.map((b) => [b.startLine, b.endLine, b.kind, b.path.join(' > ')])).toEqual([
      [1, 1, 'heading', 'Plan: Zoom'],
      [3, 3, 'text', 'Plan: Zoom'],
      [5, 5, 'heading', 'Plan: Zoom > Part A'],
      [7, 8, 'item', 'Plan: Zoom > Part A'],
      [10, 15, 'item', 'Plan: Zoom > Part A'],
      [17, 17, 'heading', 'Plan: Zoom > Part A > Part A.1'],
      [18, 18, 'text', 'Plan: Zoom > Part A > Part A.1'],
      [20, 20, 'heading', 'Plan: Zoom > Part B'],
      [21, 21, 'item', 'Plan: Zoom > Part B'],
      [22, 22, 'item', 'Plan: Zoom > Part B'],
    ]);
    expect(blocks[4]?.text).toBe('2. Second step\n   ```ts\n   const a = 1;\n\n   3. not an item\n   ```');
  });

  it('cuts at headings and where a list interrupts a paragraph, not inside list items or fences', () => {
    const blocks = splitPlanBlocks('# A\ntext\n## B\nmore\n- x\n  ## not cut\n- y\n```\n# no heading\n```');
    expect(blocks.map((b) => [b.text, b.path.join(' > ')])).toEqual([
      ['# A', 'A'],
      ['text', 'A'],
      ['## B', 'A > B'],
      ['more', 'A > B'],
      ['- x\n  ## not cut', 'A > B'],
      ['- y\n```\n# no heading\n```', 'A > B'],
    ]);
    // `2.` cannot interrupt a paragraph (CommonMark): it stays text.
    expect(splitPlanBlocks('see\n2. later').map((b) => b.text)).toEqual(['see\n2. later']);
  });

  it('a tight list without blank lines is split too; CRLF counts as one line break', () => {
    const blocks = splitPlanBlocks('- a\r\n- b\r\n  - c\r\n- d');
    expect(blocks.map((b) => [b.text, b.startLine])).toEqual([
      ['- a', 1],
      ['- b\n  - c', 2],
      ['- d', 4],
    ]);
  });

  it('headingOf and plainInline', () => {
    expect(headingOf('## Part `A` **now** ##')).toEqual({ level: 2, text: 'Part A now' });
    expect(headingOf('#hashtag')).toBeNull();
    expect(plainInline('see [docs](https://x.example) and _this_')).toBe('see docs and this');
    // An underscore inside a word and a lone star are no emphasis.
    expect(plainInline('Update config_file and run_tests, 2 * 3 = 6')).toBe(
      'Update config_file and run_tests, 2 * 3 = 6',
    );
    expect(plainInline('**bold** *it* __b__ ~~gone~~ `code`')).toBe('bold it b gone code');
  });
});

describe('text anchors (WP-93)', () => {
  it('quoteAt keeps 32 characters of context; findQuote picks the occurrence by its context', () => {
    const text = `${'a'.repeat(40)} step one; later: step one again`;
    const second = text.lastIndexOf('step one');
    const anchor = quoteAt(text, { start: second, end: second + 8 });
    expect(anchor.quote).toBe('step one');
    expect(anchor.prefix).toHaveLength(32);
    expect(findQuote(text, anchor)).toEqual({ start: second, end: second + 8 });
    expect(findQuote(text, { quote: 'step one', prefix: '', suffix: '' })?.start).toBe(
      text.indexOf('step one'),
    );
    expect(findQuote(text, { quote: 'missing', prefix: '', suffix: '' })).toBeNull();
    expect(findQuote(text, { quote: '', prefix: '', suffix: '' })).toBeNull();
  });

  it('spanOfRange and rangeOfSpan map between DOM ranges and text offsets', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>Hello <strong>bold</strong> world</p><ul><li>item</li></ul>';
    document.body.append(root);
    const span = { start: 6, end: 15 };
    const range = rangeOfSpan(root, span);
    expect(range?.toString()).toBe('bold worl');
    expect(range === null ? null : spanOfRange(root, range)).toEqual(span);
    expect(rangeOfSpan(root, { start: 0, end: 99 })).toBeNull();
    const outside = document.createRange();
    outside.selectNodeContents(document.body);
    expect(spanOfRange(root, outside)).toBeNull();
    root.remove();
  });
});

describe('buildPlanFeedback (WP-93)', () => {
  const at = (block: number, p: Partial<PlanAnnotation>) =>
    samplePlanAnnotation({ id: `pa_${String(block)}_${p.quote ?? ''}`, block, ...p });

  it('without annotations it is the general text alone', () => {
    expect(buildPlanFeedback(PLAN, [], '  Just this.  ', t)).toBe('Just this.');
    expect(buildPlanFeedback(PLAN, [], '', t)).toBe('');
  });

  it('numbers the annotations in plan order with section, line, quote and comment; general last', () => {
    const annotations = [
      at(8, { kind: 'strike', quote: '', comment: '' }),
      at(3, { quote: 'nested detail', prefix: 'First step', comment: 'Too vague.\nName the file.' }),
      at(1, { quote: 'bold text', comment: 'Why bold?' }),
      at(4, { kind: 'strike', quote: 'const a = 1;', comment: 'not needed' }),
      at(3, { quote: '', comment: 'Split this step.' }),
    ];
    expect(buildPlanFeedback(PLAN, annotations, 'Also add tests.', t)).toBe(
      [
        'Please revise the plan. My 5 annotations:',
        '1. Section "Plan: Zoom", line 3\n   > bold text\n   Why bold?',
        '2. Section "Plan: Zoom › Part A", lines 7–8\n   > First step\n   Split this step.',
        '3. Section "Plan: Zoom › Part A", line 8\n   > nested detail\n   Too vague.\n   Name the file.',
        '4. Section "Plan: Zoom › Part A", line 12\n   > const a = 1;\n   Remove this passage: not needed',
        '5. Section "Plan: Zoom › Part B", line 21\n   > one\n   Remove this passage.',
        'General:\nAlso add tests.',
      ].join('\n\n'),
    );
  });

  it('one annotation: singular intro; a long quote is clipped; an unknown block has no location', () => {
    const long = 'x'.repeat(FEEDBACK_QUOTE_CHARS + 50);
    const text = buildPlanFeedback(PLAN, [at(99, { quote: long, comment: 'c' })], '', t);
    const [intro, entry] = text.split('\n\n');
    expect(intro).toBe('Please revise the plan. My annotation:');
    expect(entry?.startsWith('1.\n   > ')).toBe(true);
    expect(entry?.split('\n')[1]).toHaveLength(FEEDBACK_QUOTE_CHARS + 5);
    expect(entry?.endsWith('…\n   c')).toBe(true);
  });

  it('sortAnnotations orders by block, position in the block, then time', () => {
    const late = at(3, { id: 'b', quote: 'First', createdAt: '2026-01-01T00:00:02.000Z' });
    const early = at(3, { id: 'a', quote: 'First', createdAt: '2026-01-01T00:00:01.000Z' });
    const whole = at(3, { id: 'w', quote: '' });
    const after = at(3, { id: 'n', quote: 'nested' });
    expect(sortAnnotations(PLAN, [after, late, whole, early]).map((a) => a.id)).toEqual(['w', 'a', 'b', 'n']);
  });
});

describe('planFeedbackSection, joinPlanFeedback, feedbackOverhead (WP-93)', () => {
  it('the overhead is exactly what the annotations add around a general text', () => {
    const annotations = [samplePlanAnnotation({ block: 1, quote: 'bold text', comment: 'Why?' })];
    const section = planFeedbackSection(PLAN, annotations, t);
    const general = 'Also add tests.';
    const joined = joinPlanFeedback(section, general, t);
    expect(joined).toBe(buildPlanFeedback(PLAN, annotations, general, t));
    expect(joined.length).toBe(general.length + feedbackOverhead(section, t));
    expect(joinPlanFeedback(section, '  ', t)).toBe(section);
    expect(feedbackOverhead('', t)).toBe(0);
    expect(planFeedbackSection(PLAN, [], t)).toBe('');
  });
});
