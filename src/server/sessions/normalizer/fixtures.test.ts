/**
 * Fixture contract tests (B "Fixture-Contract-Tests mit Snapshots"): every recorded SDK stream
 * runs through the live adapter like the engine drives it. Snapshots (file snapshots in
 * __snapshots__/live/) hold the op timeline, all signals, the final items per conversation and
 * the merged detail – an SDK upgrade shows up as a snapshot diff (B "SDK-Upgrade-Prozess").
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LIMITS } from '@shared/common';
import type { TranscriptItem } from '@shared/model';
import { sessionOpSchema } from '@shared/protocol';
import { sampleDetail, SAMPLE_IDS } from '@shared/samples';
import { applySessionOp, type SessionViewState } from '@shared/sync';
import {
  finalItems,
  loadAllFixtures,
  mergedDetail,
  replayLive,
  signalList,
  snapshotJson,
  timeline,
  type LiveReplay,
} from './testing/harness';

const fixtures = await loadAllFixtures();
const scenarios = [...fixtures.keys()];

function replayOf(scenario: string): LiveReplay {
  const fixture = fixtures.get(scenario);
  if (fixture === undefined) throw new Error(`fixture ${scenario} missing`);
  return replayLive(fixture);
}

function emptyView(replay: LiveReplay): SessionViewState {
  const conversationId = replay.conversations[0] ?? SAMPLE_IDS.conversation;
  return {
    entryId: SAMPLE_IDS.entry,
    seq: 0,
    conversationId,
    items: [],
    hasEarlier: false,
    decisions: [],
    detail: sampleDetail({ conversationId, conversations: [], init: null, models: null, unknownCounts: {} }),
  };
}

/** Items that are exempt from the size budget (assistant text is never capped). */
function budgetRelevant(item: TranscriptItem): boolean {
  return item.kind !== 'assistant_text';
}

describe('fixture set', () => {
  it('covers every recorded scenario', () => {
    expect(scenarios).toEqual([
      'ask-user-question',
      'auth-probe',
      'clear-rename',
      'history',
      'interrupt',
      'interrupt-requesting',
      'permissions',
      'permissions-rules',
      'plan-mode',
      'queue-priority',
      'resume',
      'subagent',
    ]);
  });
});

describe.each(scenarios)('live normalizer: %s', (scenario) => {
  const replay = replayOf(scenario);
  const ops = replay.steps.flatMap((s) => s.ops);

  it('emits only schema-true ops (R0-28: parse leaves every op unchanged)', () => {
    for (const op of ops) expect(sessionOpSchema.parse(op)).toStrictEqual(op);
  });

  it('streamed deltas add up to the final assistant message (matched by message id)', () => {
    let view = emptyView(replay);
    let compared = 0;
    for (const op of ops) {
      if (op.op === 'item.upsert') {
        const before = view.items.find((i) => i.id === op.item.id);
        const after = op.item;
        if (before?.kind === 'assistant_text' && after.kind === 'assistant_text' && before.streaming && !after.streaming) {
          if (!after.aborted) expect(before.text).toBe(after.text);
          compared++;
        }
        if (before?.kind === 'thinking' && after.kind === 'thinking' && before.streaming && !after.streaming) {
          if (after.text.truncated === null) expect(before.text.text).toBe(after.text.text);
          compared++;
        }
        if (
          before?.kind === 'tool_call' &&
          after.kind === 'tool_call' &&
          before.status === 'streaming_input' &&
          after.status !== 'streaming_input' &&
          after.inputTruncated === null
        ) {
          // The final message may ENRICH the streamed input (CLI defaults like Edit.replace_all,
          // ExitPlanMode.plan/planFilePath injected by the CLI) – it replaces the partial (B).
          const partial = before.inputPartial ?? '';
          const streamed: unknown = partial === '' ? {} : JSON.parse(partial);
          expect(after.input).toMatchObject(z.record(z.string(), z.unknown()).parse(streamed));
          compared++;
        }
      }
      view = applySessionOp(view, op);
    }
    const streamed = ops.some((op) => op.op === 'item.delta');
    expect(compared > 0).toBe(streamed);
  });

  it('keeps every item within LIMITS.itemTotalChars and ids unique per conversation', () => {
    for (const items of Object.values(finalItems(replay))) {
      const ids = items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      const orders = items.map((i) => i.order);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      for (const item of items.filter(budgetRelevant)) {
        expect(JSON.stringify(item).length).toBeLessThanOrEqual(LIMITS.itemTotalChars);
      }
    }
  });

  it('the shared reducer reproduces the final items of the current conversation', () => {
    const view = ops.reduce(applySessionOp, emptyView(replay));
    const current = replay.conversations.at(-1) ?? '';
    expect(view.items).toEqual(finalItems(replay)[current] ?? []);
    expect(view.items.some((i) => (i.kind === 'assistant_text' || i.kind === 'thinking') && i.streaming)).toBe(false);
  });

  it('matches the snapshot', async () => {
    const snapshot = {
      scenario,
      conversations: replay.conversations,
      timeline: timeline(replay),
      signals: signalList(replay),
      items: finalItems(replay),
      detail: mergedDetail(replay),
      unknownCounts: replay.normalizer.unknownCounts,
      ignoredCounts: replay.normalizer.ignoredCounts,
    };
    await expect(snapshotJson(snapshot)).toMatchFileSnapshot(`./__snapshots__/live/${scenario}.json`);
  });
});
