import { describe, expect, it } from 'vitest';
import type { DecisionId } from '@shared/common';
import type { DecisionOutcome } from '@shared/model';
import { sampleDecisions, sampleId, samplePlanVersionInfo, sampleTime } from '@shared/samples';
import { translate, type TranslationKey, type TranslationParams } from '@web/i18n';
import {
  automaticPlanView,
  mergePlanVersions,
  planStatusLabel,
  planStatusOf,
  previousPlanVersion,
  resolvePlanView,
  type PlanVersionEntry,
  type PlanViewContext,
} from './plan-versions';

const t = (key: TranslationKey, params?: TranslationParams) => translate('en', key, params);

const v1 = samplePlanVersionInfo({
  version: 1,
  decisionId: sampleId('dc', 1),
  createdAt: sampleTime(10),
  outcome: { type: 'plan_revised' },
});
const v2 = samplePlanVersionInfo({ version: 2, decisionId: sampleId('dc', 2), createdAt: sampleTime(20) });

const NONE = new Map<DecisionId, DecisionOutcome>();

function entry(version: number, p: Partial<PlanVersionEntry> = {}): PlanVersionEntry {
  return {
    version,
    decisionId: sampleId('dc', version),
    createdAt: sampleTime(version * 10),
    planFilePath: null,
    stored: true,
    status: { kind: 'revised' },
    knownText: null,
    knownPreviousText: null,
    ...p,
  };
}

function context(p: Partial<PlanViewContext> = {}): PlanViewContext {
  return { liveItemId: null, hasFile: true, fileWrittenAt: null, entries: [], ...p };
}

describe('plan version status', () => {
  it('maps outcomes and names approvals with the mode and the fresh context', () => {
    expect(planStatusOf({ type: 'plan_revised' })).toEqual({ kind: 'revised' });
    expect(planStatusOf(null)).toEqual({ kind: 'closed' });
    expect(planStatusOf({ type: 'expired' })).toEqual({ kind: 'expired' });
    const fresh = planStatusOf({ type: 'plan_approved', mode: 'auto', edited: false, freshContext: true });
    expect(planStatusLabel(fresh, t)).toBe('Implemented in a new conversation (Auto)');
    const plain = planStatusOf({
      type: 'plan_approved',
      mode: 'acceptEdits',
      edited: false,
      freshContext: false,
    });
    expect(planStatusLabel(plain, t)).toBe('Approved · Accept edits');
    expect(planStatusLabel({ kind: 'revised' }, t)).toBe('Rejected with feedback');
    expect(planStatusLabel({ kind: 'open' }, t)).toBe('Open');
  });
});

describe('mergePlanVersions', () => {
  it('lists the stored versions newest first; the transcript outcome beats the list', () => {
    const outcomes = new Map<DecisionId, DecisionOutcome>([
      [v2.decisionId, { type: 'plan_approved', mode: 'auto', edited: false, freshContext: true }],
    ]);
    const merged = mergePlanVersions([v1, v2], [], outcomes, null);
    expect(merged.map((item) => [item.version, item.status])).toEqual([
      [2, { kind: 'approved', mode: 'auto', fresh: true }],
      [1, { kind: 'revised' }],
    ]);
    expect(merged[0]?.knownText).toBeNull();
  });

  it('an open or expired decision is the truth for its version (also before plan.list answers)', () => {
    const open = sampleDecisions.plan({
      id: sampleId('dc', 2),
      version: 2,
      plan: '# v2',
      previousVersionPlan: '# v1',
    });
    const listed = mergePlanVersions([v1, v2], [open], NONE, null);
    expect(listed[0]).toMatchObject({
      version: 2,
      status: { kind: 'open' },
      knownText: '# v2',
      knownPreviousText: '# v1',
      createdAt: v2.createdAt,
    });
    const early = mergePlanVersions(null, [{ ...open, state: 'expired' }], NONE, null);
    expect(early.map((item) => [item.version, item.status.kind])).toEqual([[2, 'waiting']]);
  });

  it('the panel copy adds its text to its version, or its version when nothing else knows it', () => {
    const copy = { decisionId: v2.decisionId, version: 2, plan: '# copy', planFilePath: null };
    expect(mergePlanVersions([v1, v2], [], NONE, copy)[0]?.knownText).toBe('# copy');
    const other = { ...copy, decisionId: sampleId('dc', 9) };
    expect(mergePlanVersions([v1, v2], [], NONE, other)[0]?.knownText).toBeNull();
    expect(mergePlanVersions(null, [], NONE, { ...copy, version: 3 }).map((item) => item.version)).toEqual([
      3,
    ]);
  });

  it('finds the previous version (the newest older one)', () => {
    const entries = [entry(3), entry(1)];
    expect(previousPlanVersion(entries, 3)?.version).toBe(1);
    expect(previousPlanVersion(entries, 1)).toBeNull();
  });
});

describe('which version the plan tab shows', () => {
  it('a running write shows the file; else the pending version; else the newest', () => {
    const entries = [entry(2, { status: { kind: 'open' } }), entry(1)];
    expect(automaticPlanView(context({ liveItemId: 'w', entries }))).toBe('current');
    expect(automaticPlanView(context({ entries }))).toBe(2);
    expect(automaticPlanView(context({ entries: [entry(2), entry(1)] }))).toBe(2);
  });

  it('the file wins when it was written after the newest version; nothing at all → null', () => {
    const entries = [entry(2)];
    const after = Date.parse(sampleTime(25));
    const before = Date.parse(sampleTime(15));
    expect(automaticPlanView(context({ entries, fileWrittenAt: after }))).toBe('current');
    expect(automaticPlanView(context({ entries, fileWrittenAt: before }))).toBe(2);
    expect(automaticPlanView(context({ entries, fileWrittenAt: after, hasFile: false }))).toBe(2);
    expect(automaticPlanView(context({ entries: [] }))).toBe('current');
    expect(automaticPlanView(context({ entries: [], hasFile: false }))).toBeNull();
  });

  it('keeps the user choice until a newer version or a new running write arrives', () => {
    const entries = [entry(2), entry(1)];
    const choice = { view: 1, decisionId: null, basisVersion: 2, basisLiveItemId: null };
    expect(resolvePlanView(choice, context({ entries }))).toBe(1);
    expect(resolvePlanView(choice, context({ entries: [entry(3), ...entries] }))).toBe(3);
    expect(resolvePlanView(choice, context({ entries, liveItemId: 'w1' }))).toBe('current');
    const duringWrite = { ...choice, basisLiveItemId: 'w1' };
    expect(resolvePlanView(duringWrite, context({ entries, liveItemId: 'w1' }))).toBe(1);
    expect(resolvePlanView(null, context({ entries }))).toBe(2);
  });

  it('"Open plan" on a card holds only while its decision is pending', () => {
    const decisionId = sampleId('dc', 2);
    const choice = { view: 2, decisionId, basisVersion: null, basisLiveItemId: null };
    const pending = [entry(2, { status: { kind: 'open' } }), entry(1)];
    expect(resolvePlanView({ ...choice, view: 1 }, context({ entries: pending }))).toBe(1);
    // Revised → the automatic view (here the newest version, or the file written afterwards).
    const revised = [entry(2), entry(1)];
    expect(resolvePlanView({ ...choice, view: 1 }, context({ entries: revised }))).toBe(2);
    expect(
      resolvePlanView(choice, context({ entries: revised, fileWrittenAt: Date.parse(sampleTime(30)) })),
    ).toBe('current');
  });
});
