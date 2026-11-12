import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as HooksModule from '@web/state/hooks';
import { resetClientStore } from '@web/state/store';
import { TASKS_SESSION_KEY } from '../testing';
import { stopTasks } from './tasks';

/** sendCommand stand-in: each command stays open until the test resolves it. */
const pending = vi.hoisted(() => ({
  open: [] as { taskId: string; resolve: () => void }[],
  maxInFlight: 0,
}));

vi.mock('@web/state/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof HooksModule>();
  return {
    ...actual,
    sendCommand: (_sessionKey: string | null, cmd: { name: string; taskId?: string }) =>
      new Promise<Record<string, never>>((resolve) => {
        pending.open.push({
          taskId: cmd.taskId ?? '',
          resolve: () => {
            resolve({});
          },
        });
        pending.maxInFlight = Math.max(pending.maxInFlight, pending.open.length);
      }),
  };
});

afterEach(() => {
  pending.open = [];
  pending.maxInFlight = 0;
  resetClientStore();
});

describe('stopTasks ("Stop all")', () => {
  it('sends one stop at a time, in order, and reports the progress', async () => {
    const progress: number[] = [];
    const done = stopTasks(TASKS_SESSION_KEY, ['a', 'b', 'c'], (count) => {
      progress.push(count);
    });
    for (const expected of ['a', 'b', 'c']) {
      await vi.waitFor(() => {
        expect(pending.open.map((entry) => entry.taskId)).toEqual([expected]);
      });
      pending.open.shift()?.resolve();
    }
    await expect(done).resolves.toBe(3);
    expect(progress).toEqual([1, 2, 3]);
    expect(pending.maxInFlight).toBe(1);
  });
});
