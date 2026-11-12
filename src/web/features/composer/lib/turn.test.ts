import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@shared/model';
import { INITIAL_STATUS_FACTS } from '@shared/status';
import { sampleItems, sampleSystemItems } from '@shared/samples';
import { lastTurnEnded, onlyBackgroundWork, workOnlyInBackground, type TurnFacts } from './turn';

const BACKGROUND: TurnFacts = { ...INITIAL_STATUS_FACTS, runState: 'working', backgroundTasks: 1 };

/** A finished turn that launched a background agent: prompt, agent call, reply, result. */
function launchTurn(): TranscriptItem[] {
  return [
    sampleItems.userMessage({ order: 1 }),
    sampleItems.toolCall({ id: 'agent', order: 2, toolName: 'Agent', status: 'background' }),
    sampleItems.assistantText({ order: 3 }),
    sampleItems.turnResult({ order: 4 }),
  ];
}

describe('turn or only background work (B18)', () => {
  it('workOnlyInBackground: working with background tasks, nothing queued, compacting or retried', () => {
    expect(workOnlyInBackground(BACKGROUND)).toBe(true);
    expect(workOnlyInBackground({ ...BACKGROUND, backgroundTasks: 0 })).toBe(false);
    expect(workOnlyInBackground({ ...BACKGROUND, runState: 'starting' })).toBe(false);
    expect(workOnlyInBackground({ ...BACKGROUND, runState: 'idle' })).toBe(false);
    expect(workOnlyInBackground({ ...BACKGROUND, queuedPrompts: 1 })).toBe(false);
    expect(workOnlyInBackground({ ...BACKGROUND, compacting: true })).toBe(false);
    expect(workOnlyInBackground({ ...BACKGROUND, retrying: true })).toBe(false);
  });

  it('lastTurnEnded: a turn_result after the last prompt, reply or tool call of the main agent', () => {
    expect(lastTurnEnded(launchTurn())).toBe(true);
    // The background agent writes on (nested items) – the turn stays ended.
    const nested = [
      ...launchTurn(),
      sampleItems.assistantText({ id: 'sub', order: 5, parentToolUseId: 'toolu_agent' }),
      sampleItems.toolCall({ id: 'sub-tool', order: 6, parentToolUseId: 'toolu_agent', status: 'running' }),
      sampleSystemItems.hook({ order: 7 }),
    ];
    expect(lastTurnEnded(nested)).toBe(true);
  });

  it('a new prompt, reply or a task notification after the result: a turn runs', () => {
    expect(lastTurnEnded([...launchTurn(), sampleItems.userMessage({ id: 'p2', order: 5 })])).toBe(false);
    expect(
      lastTurnEnded([...launchTurn(), sampleItems.thinking({ id: 't2', order: 5, streaming: true })]),
    ).toBe(false);
    expect(
      lastTurnEnded([...launchTurn(), sampleItems.toolCall({ id: 'c2', order: 5, status: 'running' })]),
    ).toBe(false);
    expect(lastTurnEnded([...launchTurn(), sampleSystemItems.task_notification({ order: 5 })])).toBe(false);
    // Without any result (first turn, or a transcript trimmed inside a long turn): a turn runs.
    expect(lastTurnEnded(launchTurn().slice(0, 3))).toBe(false);
    expect(lastTurnEnded([])).toBe(false);
  });

  it('onlyBackgroundWork: facts and transcript together; a prompt on its way counts as a turn', () => {
    expect(onlyBackgroundWork(BACKGROUND, launchTurn(), 0)).toBe(true);
    expect(onlyBackgroundWork(BACKGROUND, launchTurn(), 1)).toBe(false);
    expect(onlyBackgroundWork({ ...BACKGROUND, backgroundTasks: 0 }, launchTurn(), 0)).toBe(false);
    expect(
      onlyBackgroundWork(BACKGROUND, [...launchTurn(), sampleItems.userMessage({ id: 'p', order: 9 })], 0),
    ).toBe(false);
  });
});
