/**
 * WP-71 – what runs where, through the real manager with the FakeBackend and a virtual clock:
 * `SessionSummary.runningTasks` for `fake:workers` (two background agents and a background shell),
 * counted like the task panel (`@shared/tasks`), recounted at most every `runningTasksMinMs`, a
 * summary only on a change, null once nothing runs and at once after the process end (the
 * background list empties with it); and the live line keeps a tool that waits for a decision.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import type { RunningTasks } from '@shared/model';
import {
  FAKE_WORKERS_AGENT_MS,
  FAKE_WORKERS_AGENTS,
  FAKE_WORKERS_DONE,
  FAKE_WORKERS_SHELL,
  FAKE_WORKERS_SHELL_MS,
} from '../backend/fake/workers';
import { nextMacrotask } from '../lib/async';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const harnesses: EngineHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(h.errors).toEqual([]);
  }
});

async function setup(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  const h = await createEngineHarness(options);
  harnesses.push(h);
  return h;
}

/** Holds every worker of `fake:workers` until the test releases its wait (ms); short waits pass. */
function workerGates() {
  const waiting = new Map<number, (() => void)[]>();
  const timing: EngineHarnessOptions['fakeTiming'] = {
    speed: 1,
    sleep: (ms) =>
      ms >= FAKE_WORKERS_SHELL_MS
        ? new Promise<void>((resolve) => {
            waiting.set(ms, [...(waiting.get(ms) ?? []), resolve]);
          })
        : nextMacrotask(),
  };
  const release = (ms: number): void => {
    for (const resolve of waiting.get(ms) ?? []) resolve();
    waiting.delete(ms);
  };
  return { timing, release };
}

/** Every published `runningTasks` of the entry, consecutive duplicates folded. */
function published(h: EngineHarness, entryId: EntryId): (RunningTasks | null)[] {
  const list = h.publisher.summaries
    .filter((s) => s.summary.entryId === entryId)
    .map((s) => s.summary.runningTasks);
  return list.filter((value, i) => i === 0 || JSON.stringify(list[i - 1]) !== JSON.stringify(value));
}

const counts = (h: EngineHarness, entryId: EntryId) => {
  const running = h.summary(entryId).runningTasks;
  return running === null ? null : { agents: running.agents, shells: running.shells, other: running.other };
};

const [AGENT_1_MS, AGENT_2_MS] = FAKE_WORKERS_AGENT_MS;

describe('SessionSummary.runningTasks (WP-71)', () => {
  it('fake:workers: two agents and a shell like the task panel; each end counts; null once all ended', async () => {
    const gates = workerGates();
    const h = await setup({ fakeTiming: gates.timing });
    const entryId = await h.create('fake:workers');
    await h.waitFor(() => h.summary(entryId).runningTasks?.shells === 1);
    await h.settle();
    expect(h.summary(entryId).runningTasks).toEqual({
      agents: 2,
      shells: 1,
      other: 0,
      items: [
        { kind: 'agent', subagentType: 'general-purpose', label: FAKE_WORKERS_AGENTS[0].summary },
        { kind: 'agent', subagentType: 'general-purpose', label: FAKE_WORKERS_AGENTS[1].summary },
        { kind: 'bash', subagentType: null, label: FAKE_WORKERS_SHELL.description },
      ],
    });
    // The same count as the panel's rows: the background list names all three.
    const view = await h.manager.loadView(entryId);
    expect(view?.detail.backgroundTasks.map((t) => t.taskType)).toEqual([
      'local_agent',
      'local_agent',
      'local_bash',
    ]);

    gates.release(FAKE_WORKERS_SHELL_MS);
    await h.waitFor(() => h.summary(entryId).runningTasks?.shells === 0);
    expect(counts(h, entryId)).toEqual({ agents: 2, shells: 0, other: 0 });
    gates.release(AGENT_1_MS);
    await h.waitFor(() => h.summary(entryId).runningTasks?.agents === 1);
    gates.release(AGENT_2_MS);
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(h.summary(entryId).runningTasks).toBeNull();
    const answers = (await h.manager.loadView(entryId))?.items.filter((i) => i.kind === 'assistant_text');
    expect(answers?.at(-1)).toMatchObject({ text: FAKE_WORKERS_DONE });
    // Counts in order (the labels change in between: description → progress summary).
    const sequence = published(h, entryId).map((r) =>
      r === null ? 'none' : `${String(r.agents)}/${String(r.shells)}`,
    );
    expect(sequence.filter((value, i) => i === 0 || sequence[i - 1] !== value)).toEqual([
      'none',
      '1/0',
      '2/0',
      '2/1',
      '2/0',
      '1/0',
      'none',
    ]);
  });

  it('recounted at most every runningTasksMinMs (first change at once); no summary without a change', async () => {
    const gates = workerGates();
    const h = await setup({ fakeTiming: gates.timing, options: { runningTasksMinMs: 2_000 } });
    const entryId = await h.create('fake:workers');
    await h.waitFor(() => h.summary(entryId).runningTasks !== null);
    await h.settle();
    // The first change went out at once; the rest waits for the pause (the virtual clock stands).
    expect(counts(h, entryId)).toEqual({ agents: 1, shells: 0, other: 0 });
    h.timers.advance(2_000);
    await h.settle();
    expect(counts(h, entryId)).toEqual({ agents: 2, shells: 1, other: 0 });
    expect(published(h, entryId).filter((r) => r !== null)).toHaveLength(2);
    // Nothing changed: the next pause publishes nothing.
    const before = h.publisher.summaries.length;
    h.timers.advance(2_000);
    await h.settle();
    expect(h.publisher.summaries.length).toBe(before);
    // Two ends within one pause: one recount after it.
    h.timers.advance(5_000);
    gates.release(FAKE_WORKERS_SHELL_MS);
    gates.release(AGENT_1_MS);
    await h.settle();
    expect(counts(h, entryId)).toEqual({ agents: 2, shells: 0, other: 0 });
    h.timers.advance(2_000);
    await h.settle();
    expect(counts(h, entryId)).toEqual({ agents: 1, shells: 0, other: 0 });
  });

  it('null at once when the process ends (also within the pause); the background list empties', async () => {
    const gates = workerGates();
    const h = await setup({ fakeTiming: gates.timing, options: { runningTasksMinMs: 60_000 } });
    const entryId = await h.create('fake:workers');
    await h.waitFor(() => h.summary(entryId).runningTasks !== null);
    await h.settle();
    h.session(entryId).crash(1);
    await h.waitFor(() => h.summary(entryId).runningTasks === null);
    await h.settle();
    expect(h.summary(entryId).runningTasks).toBeNull();
    expect((await h.manager.loadView(entryId))?.detail.backgroundTasks).toEqual([]);
  });

  it('a session without tasks never gets runningTasks', async () => {
    const h = await setup();
    const entryId = await h.create('hello');
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(published(h, entryId)).toEqual([null]);
  });
});

describe('live line with an open decision (WP-71, rest of WP-68)', () => {
  it('the tool that waits for the decision stays the activity – no fallback to "thinking"', async () => {
    const h = await setup();
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    await h.settle();
    expect(h.summary(entryId).activity).toEqual({
      kind: 'tool',
      tool: 'Bash',
      target: 'Create fake-dir and list the folder',
    });
  });
});
