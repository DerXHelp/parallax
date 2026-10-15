/**
 * Size rules (docs/architecture.md §6, R0-11): capping, blobs, dedupe and the per-item budget.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import { sampleItems } from '@shared/samples';
import * as normalizer from './index';
import { capInput, capStructured, capText, dedupeStructured, fitToolCall, jsonChars, shareBudget, shrinkCapped } from './limits';
import { testContext } from './testing/harness';

const ctx = testContext();

describe('public exports', () => {
  it('re-exports capText/capInput for the engine (WP-13 §6 Nr. 6)', () => {
    expect(normalizer.capText).toBe(capText);
    expect(normalizer.capInput).toBe(capInput);
  });
});

describe('capText / shrinkCapped', () => {
  it('keeps short texts and stores the full long text as a blob', () => {
    expect(capText('short', ctx)).toEqual({ text: 'short', truncated: null });
    const long = 'a'.repeat(LIMITS.itemTextChars + 1);
    const capped = capText(long, ctx);
    expect(capped.text).toHaveLength(LIMITS.itemTextChars);
    expect(capped.truncated?.totalChars).toBe(long.length);
    expect(ctx.blobs.get(capped.truncated?.blobId ?? '')?.bytes).toBe(long.length);
  });

  it('never splits a surrogate pair', () => {
    const text = `${'a'.repeat(9)}😀b`;
    expect(capText(text, ctx, 10).text).toBe('a'.repeat(9));
  });

  it('shrinking keeps the blob of the original text', () => {
    const capped = capText('b'.repeat(100), ctx, 50);
    const smaller = shrinkCapped(capped, 10, ctx);
    expect(smaller).toEqual({ text: 'b'.repeat(10), truncated: capped.truncated });
    expect(shrinkCapped({ text: 'c'.repeat(20), truncated: null }, 10, ctx).truncated?.totalChars).toBe(20);
  });
});

describe('capInput / capStructured', () => {
  it('caps long strings in place, one blob with the full input; plan text exempt', () => {
    const input = { file_path: 'x', content: 'z'.repeat(200), nested: [{ s: 'y'.repeat(200) }] };
    const capped = capInput(input, 'Write', ctx, 50);
    expect(capped.input).toEqual({ file_path: 'x', content: 'z'.repeat(50), nested: [{ s: 'y'.repeat(50) }] });
    expect(capped.inputTruncated?.totalChars).toBe(JSON.stringify(input).length);
    const plan = { plan: 'p'.repeat(200) };
    expect(capInput(plan, 'ExitPlanMode', ctx, 50)).toEqual({ input: plan, inputTruncated: null });
  });

  it('moves a large structured result into a blob as a whole', () => {
    expect(capStructured({ a: 1 }, ctx)).toEqual({ structured: { a: 1 }, structuredTruncated: null });
    const big = { rows: 'r'.repeat(LIMITS.itemStructuredChars) };
    expect(capStructured(big, ctx)).toMatchObject({ structured: null, structuredTruncated: { totalChars: JSON.stringify(big).length } });
    expect(capStructured(null, ctx)).toEqual({ structured: null, structuredTruncated: null });
  });
});

describe('dedupeStructured (R0-11)', () => {
  it('removes stdout/stderr contained in the result text for Bash/PowerShell', () => {
    expect(dedupeStructured('Bash', { stdout: 'out', stderr: '', interrupted: false }, 'out')).toEqual({ interrupted: false });
    expect(dedupeStructured('PowerShell', { stdout: 'other', stderr: 'err' }, 'err')).toEqual({ stdout: 'other' });
  });

  it('removes file.content of Read when the numbered text contains it; other tools unchanged', () => {
    const structured = { type: 'text', file: { filePath: 'a', content: 'x\ny', numLines: 2 } };
    expect(dedupeStructured('Read', structured, '1\tx\n2\ty')).toEqual({ type: 'text', file: { filePath: 'a', numLines: 2 } });
    expect(dedupeStructured('Read', structured, 'something else')).toEqual(structured);
    expect(dedupeStructured('Edit', { stdout: 'x' }, 'x')).toEqual({ stdout: 'x' });
  });
});

describe('fitToolCall: LIMITS.itemTotalChars', () => {
  it('moves structured first, then result text, then input strings', () => {
    const base = sampleItems.toolCall();
    const text = 'o'.repeat(40 * 1024);
    const item = {
      ...base,
      input: { command: 'i'.repeat(40 * 1024) },
      result: {
        isError: false,
        content: [{ type: 'text' as const, text: { text, truncated: null } }],
        structured: { blob: 's'.repeat(40 * 1024) },
        structuredTruncated: null,
        at: base.at,
      },
    };
    const fitted = fitToolCall(item, ctx);
    expect(jsonChars(fitted)).toBeLessThanOrEqual(LIMITS.itemTotalChars);
    expect(fitted.result?.structured).toBeNull();
    expect(fitted.result?.structuredTruncated).not.toBeNull();
    // Structured + 16 Ki text were enough: the input stays untouched.
    expect(fitted.input).toEqual(item.input);
    const part = fitted.result?.content[0];
    expect(part?.type === 'text' ? part.text.truncated?.totalChars : null).toBe(text.length);
  });

  it('leaves small items untouched', () => {
    const item = sampleItems.toolCall();
    expect(fitToolCall(item, ctx)).toBe(item);
  });
});

describe('shareBudget', () => {
  it('splits the budget over all present texts', () => {
    const entries = [
      { path: 'a', content: { text: 'a'.repeat(1000), truncated: null } },
      { path: 'b', content: null },
      { path: 'c', content: { text: 'c'.repeat(1000), truncated: null } },
    ];
    const shared = shareBudget(entries, 1000, ctx);
    expect(shared.map((e) => e.content?.text.length ?? null)).toEqual([500, null, 500]);
  });
});
