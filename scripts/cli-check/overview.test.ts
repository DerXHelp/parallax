/**
 * WP-65 §1.7: the overview step of `pnpm cli-check` with a fake Query handle – never live. Answer
 * shapes as SDK 0.3.322 types them (`generateSessionTitle` → title string, usage query → `rate_limits`
 * with `utilization` 0–100 and `resets_at`).
 */
import { describe, expect, it } from 'vitest';
import { parseCliProfile } from '../../src/server/claude/cliProfile';
import { compareObservation, overviewFindings } from './compare';
import { observationFrom } from './observation';
import { bridgeSummaryCounts, probeOverview, TITLE_PROBE_DESCRIPTION, type OverviewProbeHandle } from './overview';
import { evaluate, formatReport, runRecordSchema } from './report';
import { sampleObservation, sampleProfile, sampleRecord } from './samples';

const USAGE = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 12, resets_at: '2026-11-12T18:00:00Z' },
    seven_day: { utilization: 40.5, resets_at: null },
    seven_day_opus: null,
  },
  session_cost_usd: 0.01,
};

function handle(p: Partial<Record<keyof OverviewProbeHandle, unknown>> = {}): OverviewProbeHandle & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const answer = (key: keyof OverviewProbeHandle, fallback: unknown) => (...args: unknown[]) => {
    calls.push([key, ...args]);
    const value = key in p ? p[key] : fallback;
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };
  return {
    calls,
    generateSessionTitle: answer('generateSessionTitle', '  CLI   test prompt check '),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: answer(
      'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET',
      USAGE,
    ),
    backgroundTasks: answer('backgroundTasks', true),
  };
}

describe('probeOverview', () => {
  it('one title request without persisting, the usage query with skipBehaviors; backgroundTasks never called', async () => {
    const h = handle();
    const lines: string[] = [];
    const result = await probeOverview(h, { controlMs: 1000, log: (line) => lines.push(line) });
    expect(result).toEqual({
      sessionTitle: { available: true, detail: null, title: 'CLI test prompt check' },
      usage: { available: true, detail: null, windows: ['five_hour', 'seven_day'] },
      backgroundTasks: true,
    });
    expect(h.calls).toEqual([
      ['generateSessionTitle', TITLE_PROBE_DESCRIPTION, { persist: false }],
      ['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET', { skipBehaviors: true }],
    ]);
    expect(lines.join('\n')).toContain('usage ok (five_hour, seven_day)');
  });

  it('missing methods (older SDK) → not available, nothing called', async () => {
    const result = await probeOverview({}, { controlMs: 1000 });
    expect(result.sessionTitle.available).toBe(false);
    expect(result.sessionTitle.detail).toContain('missing');
    expect(result.usage.available).toBe(false);
    expect(result.usage.detail).toContain('missing');
    expect(result.backgroundTasks).toBe(false);
  });

  it('wrong answers and failures are findings, not stops', async () => {
    const wrong = await probeOverview(
      handle({
        generateSessionTitle: { title: 'object, not string' },
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: { rate_limits: 'nope' },
      }),
      { controlMs: 1000 },
    );
    expect(wrong.sessionTitle).toMatchObject({ available: false, title: null });
    expect(wrong.sessionTitle.detail).toContain('no title string');
    expect(wrong.usage.available).toBe(false);
    expect(wrong.usage.detail).toContain('no rate_limits object');

    const noPlan = await probeOverview(
      handle({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: { rate_limits_available: false, rate_limits: null } }),
      { controlMs: 1000 },
    );
    expect(noPlan.usage.detail).toContain('rate_limits_available is false');

    // resets_at as a number (epoch) no longer matches: no usable window.
    const changed = await probeOverview(
      handle({
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: {
          rate_limits: { five_hour: { utilization: 12, resets_at: 1_789_000_000 } },
        },
      }),
      { controlMs: 1000 },
    );
    expect(changed.usage).toMatchObject({ available: false, windows: [] });
    expect(changed.usage.detail).toContain('no window');

    const failed = await probeOverview(
      handle({
        generateSessionTitle: new Error('model overloaded'),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: new Error('not supported'),
      }),
      { controlMs: 1000 },
    );
    expect(failed.sessionTitle.detail).toBe('generateSessionTitle failed: model overloaded');
    expect(failed.usage.detail).toBe('usage query failed: not supported');
  });

  it('a request that never answers times out', async () => {
    const never = await probeOverview(
      { generateSessionTitle: () => new Promise<unknown>(() => undefined) },
      { controlMs: 5 },
    );
    expect(never.sessionTitle.available).toBe(false);
    expect(never.sessionTitle.detail).toContain('generateSessionTitle failed');
  });

  it('bridge summaries are counted from the probe message types', () => {
    expect(bridgeSummaryCounts({ 'system/post_turn_summary': 1, assistant: 2 })).toEqual({ taskSummary: 0, postTurnSummary: 1 });
  });
});

describe('profile and comparison', () => {
  it('profiles before WP-65 read the three fields as null; observations carry them', () => {
    const { sessionTitle: _a, usageQuery: _b, backgroundTasks: _c, ...older } = sampleProfile();
    expect(parseCliProfile(older)).toMatchObject({ sessionTitle: null, usageQuery: null, backgroundTasks: null });
    const observation = observationFrom(
      {
        init: { type: 'system', subtype: 'init', claude_code_version: '2.1.322' },
        initializationResult: null,
        supportedModels: null,
        contextUsage: null,
        sessionTitle: true,
        usageQuery: false,
        backgroundTasks: true,
      },
      '0.3.322',
    );
    expect(observation).toMatchObject({ sessionTitle: true, usageQuery: false, backgroundTasks: true });
  });

  it('true → false is a deviation with the place in Parallax; first check / not checked a note', () => {
    const lost = overviewFindings(sampleProfile(), sampleObservation({ usageQuery: false, backgroundTasks: false }));
    expect(lost.map((f) => [f.area, f.level])).toEqual([
      ['usageQuery', 'deviation'],
      ['backgroundTasks', 'deviation'],
    ]);
    expect(lost[0]?.hint).toContain('usagePoll.ts');
    const first = overviewFindings(sampleProfile({ sessionTitle: null }), sampleObservation());
    expect(first).toEqual([expect.objectContaining({ area: 'sessionTitle', level: 'note' })]);
    expect(compareObservation(sampleProfile(), sampleObservation())).toEqual([]);
  });

  it('the run record keeps the step; the report lists it (older records read as null)', () => {
    const record = sampleRecord();
    expect(runRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
    const { probe } = record;
    if (probe === null) throw new Error('sample without probe');
    const { overview: _ignored, ...olderProbe } = probe;
    expect(runRecordSchema.parse({ ...record, probe: olderProbe }).probe?.overview).toBeNull();

    const failed = sampleRecord({
      observation: sampleObservation({ sessionTitle: false }),
      probe: {
        ...probe,
        messageTypes: { ...probe.messageTypes, 'system/task_summary': 2 },
        overview: {
          sessionTitle: { available: false, detail: 'generateSessionTitle failed: x', title: null },
          usage: { available: true, detail: null, windows: ['five_hour'] },
          backgroundTasks: true,
        },
      },
    });
    const evaluation = evaluate(failed, sampleProfile());
    expect(evaluation.exitCode).toBe(1);
    const report = formatReport({ record: failed, profile: sampleProfile(), profilePath: 'p.json', evaluation, mode: 'live' });
    expect(report).toContain('- session title: NOT ok – generateSessionTitle failed: x');
    expect(report).toContain('- usage query: ok (five_hour)');
    expect(report).toContain('- backgroundTasks: present');
    expect(report).toContain('task_summary×2, post_turn_summary×0');
  });
});
