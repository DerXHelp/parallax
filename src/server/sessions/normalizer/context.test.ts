/**
 * Context gauge (C.1): recorded `getContextUsage({detail:'summary'})` answers → ContextBreakdown
 * (file snapshots), the in-turn estimate from `context_estimate` signals and the context window
 * from `result.modelUsage`.
 */
import { describe, expect, it } from 'vitest';
import { contextBreakdownSchema, contextGaugeSchema } from '@shared/model';
import { fixtureCallPayloadSchema } from '../../backend/fixture';
import { estimateContextGauge, modelContextWindow, normalizeContextUsage } from './index';
import { loadAllFixtures, replayLive, snapshotJson } from './testing/harness';

const fixtures = await loadAllFixtures();
const AT = new Date('2026-10-15T08:00:00.000Z');

const withUsage = [...fixtures].flatMap(([scenario, fixture]) => {
  const calls = fixture.events.flatMap((e) => {
    if (e.kind !== 'call') return [];
    const call = fixtureCallPayloadSchema.parse(e.payload);
    return call.fn === 'getContextUsage' ? [{ seq: e.seq, args: call.args, result: call.result }] : [];
  });
  return calls.length === 0 ? [] : [[scenario, calls] as const];
});

describe('recorded getContextUsage answers', () => {
  it('exist in several fixtures', () => {
    expect(withUsage.map(([s]) => s)).toEqual(['auth-probe', 'permissions', 'plan-mode', 'subagent']);
  });

  it.each(withUsage)('%s → ContextBreakdown snapshot', async (scenario, calls) => {
    const breakdowns = calls.map((c) => ({ seq: c.seq, breakdown: normalizeContextUsage(c.result, { contextWindow: null }, AT, 'summary') }));
    for (const { breakdown } of breakdowns) {
      expect(breakdown).not.toBeNull();
      expect(contextBreakdownSchema.parse(breakdown)).toStrictEqual(breakdown);
    }
    await expect(snapshotJson(breakdowns)).toMatchFileSnapshot(`./__snapshots__/context/${scenario}.json`);
  });
});

describe('normalizeContextUsage', () => {
  const raw = {
    categories: [
      { name: 'System prompt', tokens: 3000, color: 'x', kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 2000, color: 'x', isDeferred: true },
      { name: 'Future row', tokens: 5, color: 'x', kind: 'brand-new' },
      { name: 'Free space', tokens: 900_000, color: 'x', kind: 'free' },
    ],
    totalTokens: 26_702,
    maxTokens: 1_000_000,
    rawMaxTokens: 1_000_000,
    percentage: 3,
    model: 'claude-haiku-5-5',
    autoCompactThreshold: 967_000,
    isAutoCompactEnabled: true,
  };

  it('keeps the SDK numbers and classifies rows by kind (unknown → deferred/used)', () => {
    expect(normalizeContextUsage(raw, { contextWindow: null }, AT, 'full')).toEqual({
      percentage: 3,
      totalTokens: 26_702,
      maxTokens: 1_000_000,
      source: 'sdk',
      model: 'claude-haiku-5-5',
      at: AT.toISOString(),
      detail: 'full',
      categories: [
        { name: 'System prompt', tokens: 3000, kind: 'used' },
        { name: 'MCP tools (deferred)', tokens: 2000, kind: 'deferred' },
        { name: 'Future row', tokens: 5, kind: 'used' },
        { name: 'Free space', tokens: 900_000, kind: 'free' },
      ],
      autoCompactThreshold: 967_000,
      isAutoCompactEnabled: true,
    });
  });

  it('applies the profile override of the context window (C.1)', () => {
    const breakdown = normalizeContextUsage(raw, { contextWindow: 200_000 }, AT, 'summary');
    expect(breakdown).toMatchObject({ maxTokens: 200_000, percentage: 13, totalTokens: 26_702 });
  });

  it('prefers rawMaxTokens over maxTokens and tolerates missing optional fields', () => {
    const breakdown = normalizeContextUsage({ totalTokens: 150_000, maxTokens: 1_000_000, rawMaxTokens: 200_000 }, { contextWindow: null }, AT, 'summary');
    expect(breakdown).toMatchObject({ maxTokens: 200_000, percentage: 75, categories: [], model: null, autoCompactThreshold: null, isAutoCompactEnabled: null });
  });

  it('returns null for unusable answers', () => {
    expect(normalizeContextUsage(null, { contextWindow: null }, AT, 'summary')).toBeNull();
    expect(normalizeContextUsage({ totalTokens: 'many' }, { contextWindow: null }, AT, 'summary')).toBeNull();
    expect(normalizeContextUsage({ totalTokens: 5 }, { contextWindow: null }, AT, 'summary')).toBeNull();
    expect(normalizeContextUsage({ totalTokens: -1, maxTokens: 10 }, { contextWindow: null }, AT, 'summary')).toBeNull();
  });
});

describe('in-turn estimate', () => {
  const estimate = {
    type: 'context_estimate',
    totalTokens: 50_000,
    model: 'claude-haiku-5-5',
    contextWindow: null,
  } as const;

  it('falls back to the window carried by the signal (R1-07)', () => {
    const withWindow = { ...estimate, contextWindow: 200_000 };
    expect(estimateContextGauge(withWindow, { override: null, lastSdkMaxTokens: null }, AT)?.maxTokens).toBe(200_000);
    expect(
      estimateContextGauge(withWindow, { override: null, lastSdkMaxTokens: null, modelContextWindow: null }, AT)
        ?.maxTokens,
    ).toBe(200_000);
    expect(estimateContextGauge(withWindow, { override: 100_000, lastSdkMaxTokens: null }, AT)?.maxTokens).toBe(
      100_000,
    );
  });

  it('uses override, then the last SDK maxTokens, then modelUsage.contextWindow', () => {
    expect(estimateContextGauge(estimate, { override: 100_000, lastSdkMaxTokens: 1_000_000, modelContextWindow: 1_000_000 }, AT)).toMatchObject({
      maxTokens: 100_000,
      percentage: 50,
      source: 'estimate',
    });
    expect(estimateContextGauge(estimate, { override: null, lastSdkMaxTokens: 200_000, modelContextWindow: 1_000_000 }, AT)?.maxTokens).toBe(200_000);
    expect(estimateContextGauge(estimate, { override: null, lastSdkMaxTokens: null, modelContextWindow: 1_000_000 }, AT)?.percentage).toBe(5);
    expect(estimateContextGauge(estimate, { override: null, lastSdkMaxTokens: null, modelContextWindow: null }, AT)).toBeNull();
  });

  it('matches the SDK value after the turn in a recorded session (auth-probe)', () => {
    const fixture = fixtures.get('auth-probe');
    if (fixture === undefined) throw new Error('auth-probe missing');
    const replay = replayLive(fixture);
    const estimates = replay.steps.flatMap((s) => s.signals).filter((s) => s.type === 'context_estimate');
    const last = estimates.at(-1);
    if (last === undefined) throw new Error('no estimate');
    const resultEvent = fixture.events.find((e) => e.kind === 'message' && JSON.stringify(e.payload).startsWith('{"duration_api_ms"'));
    const window = modelContextWindow(resultEvent?.payload, last.model);
    expect(window).toBe(1_000_000);
    // auth-probe has one turn: its estimates come before the first result, so they carry no window.
    expect(estimates.map((s) => s.contextWindow)).toEqual(estimates.map(() => null));
    const gauge = estimateContextGauge(last, { override: null, lastSdkMaxTokens: null, modelContextWindow: window }, AT);
    expect(contextGaugeSchema.parse(gauge)).toStrictEqual(gauge);
    const sdk = normalizeContextUsage(
      fixtureCallPayloadSchema.parse(fixture.events.find((e) => e.kind === 'call')?.payload).result,
      { contextWindow: null },
      AT,
      'summary',
    );
    expect(gauge?.percentage).toBe(sdk?.percentage);
    expect(Math.abs((gauge?.totalTokens ?? 0) - (sdk?.totalTokens ?? 0))).toBeLessThan(1000);
  });

  it('modelContextWindow: exact model, else the largest window, null without result', () => {
    const result = { type: 'result', subtype: 'success', modelUsage: { a: { contextWindow: 200_000 }, b: { contextWindow: 1_000_000 } } };
    expect(modelContextWindow(result, 'a')).toBe(200_000);
    expect(modelContextWindow(result, 'unknown')).toBe(1_000_000);
    expect(modelContextWindow(result, null)).toBe(1_000_000);
    expect(modelContextWindow({ type: 'assistant' }, 'a')).toBeNull();
    expect(modelContextWindow({ type: 'result', modelUsage: {} }, 'a')).toBeNull();
  });
});
