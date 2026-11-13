/**
 * WP-66 §1.4: the side-question step of `pnpm cli-check` with a fake Query handle – never live.
 * Answer shape as SDK 0.3.322 maps it (`askSideQuestion` → `{response, synthetic, refusalFallback?}`
 * or null; `cancelAsyncMessage` only checked for existence).
 */
import { describe, expect, it } from 'vitest';
import { parseCliProfile } from '../../src/server/claude/cliProfile';
import { compareObservation, overviewFindings } from './compare';
import { observationFrom } from './observation';
import { evaluate, formatReport, runRecordSchema } from './report';
import { sampleObservation, sampleProfile, sampleRecord } from './samples';
import { probeSideQuestion, SIDE_QUESTION_PROBE, type SideQuestionProbeHandle } from './sideQuestion';

function handle(answer: unknown = { response: 'OK', synthetic: false }, onAsk: () => void = () => undefined) {
  const calls: unknown[][] = [];
  const h: SideQuestionProbeHandle & { calls: unknown[][] } = {
    calls,
    askSideQuestion: (...args) => {
      calls.push(['askSideQuestion', ...args]);
      onAsk();
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    cancelAsyncMessage: (...args) => {
      calls.push(['cancelAsyncMessage', ...args]);
      return Promise.resolve(true);
    },
  };
  return h;
}

describe('probeSideQuestion', () => {
  it('one side question without history; cancelAsyncMessage never called', async () => {
    const h = handle();
    const lines: string[] = [];
    const result = await probeSideQuestion(h, { timeoutMs: 1000, toolRequests: () => 0, log: (l) => lines.push(l) });
    expect(result).toEqual({
      sideQuestion: { available: true, detail: null, response: 'OK', synthetic: false, toolRequests: 0 },
      withdrawQueued: true,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.[0]).toBe('askSideQuestion');
    expect(h.calls[0]?.[1]).toBe(SIDE_QUESTION_PROBE);
    expect(h.calls[0]?.[2]).toEqual({ signal: expect.any(AbortSignal) as unknown });
    expect(lines.join('\n')).toContain('side question ok ("OK"), cancelAsyncMessage present');
  });

  it('missing methods (older SDK) → not available, nothing called', async () => {
    const result = await probeSideQuestion({}, { timeoutMs: 1000, toolRequests: () => 0 });
    expect(result.sideQuestion).toMatchObject({ available: false, response: null });
    expect(result.sideQuestion.detail).toContain('missing');
    expect(result.withdrawQueued).toBe(false);
  });

  it('wrong shapes, null, synthetic answers and failures are findings, not stops', async () => {
    const opts = { timeoutMs: 1000, toolRequests: () => 0 };
    const noSynthetic = await probeSideQuestion(handle({ response: 'OK' }), opts);
    expect(noSynthetic.sideQuestion.detail).toContain('not {response: string, synthetic: boolean}');
    const wrong = await probeSideQuestion(handle({ text: 'OK', synthetic: false }), opts);
    expect(wrong.sideQuestion.available).toBe(false);
    const none = await probeSideQuestion(handle(null), opts);
    expect(none.sideQuestion.detail).toContain('null');
    const synthetic = await probeSideQuestion(handle({ response: 'No response', synthetic: true }), opts);
    expect(synthetic.sideQuestion).toMatchObject({ available: false, synthetic: true, response: 'No response' });
    expect(synthetic.sideQuestion.detail).toContain('synthetically');
    const busy = await probeSideQuestion(handle(Object.assign(new Error('busy'), { errorCode: 'side_question_busy' })), opts);
    expect(busy.sideQuestion.detail).toBe('askSideQuestion failed (side_question_busy): busy');
    const failed = await probeSideQuestion(handle(new Error('model overloaded')), opts);
    expect(failed.sideQuestion.detail).toBe('askSideQuestion failed: model overloaded');
  });

  it('a canUseTool call while it runs makes it not available', async () => {
    let tools = 0;
    const result = await probeSideQuestion(
      handle({ response: 'OK', synthetic: false }, () => {
        tools += 1;
      }),
      { timeoutMs: 1000, toolRequests: () => tools },
    );
    expect(result.sideQuestion).toMatchObject({ available: false, toolRequests: 1, response: 'OK' });
    expect(result.sideQuestion.detail).toContain('canUseTool was called 1×');
  });

  it('a request that never answers times out and is aborted', async () => {
    let signal: AbortSignal | undefined;
    const result = await probeSideQuestion(
      {
        askSideQuestion: (_q, o) => {
          signal = o?.signal;
          return new Promise<unknown>(() => undefined);
        },
      },
      { timeoutMs: 5, toolRequests: () => 0 },
    );
    expect(result.sideQuestion.available).toBe(false);
    expect(result.sideQuestion.detail).toContain('askSideQuestion failed');
    expect(signal?.aborted).toBe(true);
  });
});

describe('profile and comparison (WP-66)', () => {
  it('profiles before WP-66 read both fields as null; observations carry them', () => {
    const { sideQuestion: _a, withdrawQueued: _b, ...older } = sampleProfile();
    expect(parseCliProfile(older)).toMatchObject({ sideQuestion: null, withdrawQueued: null });
    const observation = observationFrom(
      {
        init: { type: 'system', subtype: 'init', claude_code_version: '2.1.322' },
        initializationResult: null,
        supportedModels: null,
        contextUsage: null,
        sideQuestion: false,
        withdrawQueued: true,
      },
      '0.3.322',
    );
    expect(observation).toMatchObject({ sideQuestion: false, withdrawQueued: true });
  });

  it('true → false is a deviation with the place in Parallax; first check a note', () => {
    const lost = overviewFindings(sampleProfile(), sampleObservation({ sideQuestion: false, withdrawQueued: false }));
    expect(lost.map((f) => [f.area, f.level])).toEqual([
      ['sideQuestion', 'deviation'],
      ['withdrawQueued', 'deviation'],
    ]);
    expect(lost[0]?.hint).toContain('sessions/sideQuestions.ts');
    const first = overviewFindings(sampleProfile({ sideQuestion: null }), sampleObservation());
    expect(first).toEqual([expect.objectContaining({ area: 'sideQuestion', level: 'note' })]);
    expect(compareObservation(sampleProfile(), sampleObservation())).toEqual([]);
  });

  it('the run record keeps the step; the report lists it (older records read as null)', () => {
    const record = sampleRecord();
    expect(runRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
    const { probe } = record;
    if (probe === null) throw new Error('sample without probe');
    const { sideQuestion: _ignored, ...olderProbe } = probe;
    expect(runRecordSchema.parse({ ...record, probe: olderProbe }).probe?.sideQuestion).toBeNull();

    const failed = sampleRecord({
      observation: sampleObservation({ sideQuestion: false }),
      probe: {
        ...probe,
        sideQuestion: {
          sideQuestion: {
            available: false,
            detail: 'Query.askSideQuestion is missing (SDK)',
            response: null,
            synthetic: null,
            toolRequests: 0,
          },
          withdrawQueued: true,
        },
      },
    });
    const evaluation = evaluate(failed, sampleProfile());
    expect(evaluation.exitCode).toBe(1);
    const report = formatReport({ record: failed, profile: sampleProfile(), profilePath: 'p.json', evaluation, mode: 'live' });
    expect(report).toContain('- side question: NOT ok – Query.askSideQuestion is missing (SDK)');
    expect(report).toContain('- cancelAsyncMessage: present');
    const green = formatReport({
      record,
      profile: sampleProfile(),
      profilePath: 'p.json',
      evaluation: evaluate(record, sampleProfile()),
      mode: 'live',
    });
    expect(green).toContain('- side question: ok ("OK")');
  });
});
