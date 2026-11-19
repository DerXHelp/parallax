import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { sampleDecisions, sampleId, samplePlanAnnotation } from '@shared/samples';
import type * as HooksModule from '@web/state/hooks';
import {
  getPlanAnnotations,
  resetPlanAnnotations,
  savePlanAnnotations,
  SETTLE_AFTER_ACK_MS,
} from './annotations';

/** sendCommand stand-in: the test answers each command. */
const control = vi.hoisted(() => ({
  open: [] as { resolve: () => void; reject: (error: Error) => void }[],
}));

vi.mock('@web/state/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof HooksModule>();
  return {
    ...actual,
    sendCommand: () =>
      new Promise<Record<string, never>>((resolve, reject) => {
        control.open.push({
          resolve: () => {
            resolve({});
          },
          reject,
        });
      }),
  };
});

const KEY = makeSessionKey(LOCAL_HOST_ID, sampleId('en', 1));
const note = samplePlanAnnotation();

afterEach(() => {
  control.open = [];
  resetPlanAnnotations();
  vi.useRealTimers();
});

describe('plan annotations overlay (WP-93)', () => {
  it('shows the change at once and keeps it after the ack until the decision carries it', async () => {
    const before = sampleDecisions.plan();
    const saved = savePlanAnnotations(KEY, before, [note]);
    expect(getPlanAnnotations(before)).toEqual([note]);
    control.open[0]?.resolve();
    await expect(saved).resolves.toBe(true);
    // The ack came before the echo: still this window's list, not the old one.
    expect(getPlanAnnotations(before)).toEqual([note]);
    // The echo (a copy, as parsed from the wire): the server's list is shown.
    const echoed = sampleDecisions.plan({ annotations: [{ ...note }] });
    expect(getPlanAnnotations(echoed)).toBe(echoed.annotations);
  });

  it('without an echo the server list wins after SETTLE_AFTER_ACK_MS', async () => {
    vi.useFakeTimers();
    const decision = sampleDecisions.plan();
    const saved = savePlanAnnotations(KEY, decision, [note]);
    control.open[0]?.resolve();
    await saved;
    expect(getPlanAnnotations(decision)).toEqual([note]);
    vi.advanceTimersByTime(SETTLE_AFTER_ACK_MS);
    expect(getPlanAnnotations(decision)).toEqual([]);
  });

  it('a refused change shows the server list again; a newer change is not settled by an older one', async () => {
    const decision = sampleDecisions.plan();
    const refused = savePlanAnnotations(KEY, decision, [note]);
    control.open[0]?.reject(new Error('offline'));
    await expect(refused).resolves.toBe(false);
    expect(getPlanAnnotations(decision)).toEqual([]);

    vi.useFakeTimers();
    const other = samplePlanAnnotation({ id: 'pa_2' });
    const first = savePlanAnnotations(KEY, decision, [note]);
    const second = savePlanAnnotations(KEY, decision, [note, other]);
    control.open[1]?.resolve();
    await first;
    vi.advanceTimersByTime(SETTLE_AFTER_ACK_MS);
    expect(getPlanAnnotations(decision)).toEqual([note, other]);
    control.open[2]?.resolve();
    await second;
    expect(getPlanAnnotations(decision)).toEqual([note, other]);
  });
});
