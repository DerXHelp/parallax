import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { LIMITS } from './common';
import {
  currentConversation,
  currentSessionId,
  decisionOutcomeSchema,
  decisionRecordSchema,
  decisionRecordsFileSchema,
  decisionResponseSchema,
  decisionSchema,
  entrySchema,
  hostStateSchema,
  profileSchema,
  profilesFileSchema,
  previousSessionIds,
  registryFileSchema,
  sessionDetailPatchSchema,
  sessionDetailSchema,
  sessionSummarySchema,
  settingsFileSchema,
  settingsPatchSchema,
  settingsSchema,
  systemItemSchema,
  transcriptItemSchema,
  type Entry,
} from './model';
import {
  SAMPLE_IDS,
  sampleConversation,
  sampleDecisionRecord,
  sampleDecisions,
  sampleDetail,
  sampleEntry,
  sampleHostState,
  sampleId,
  sampleItems,
  sampleOutcomes,
  sampleProfile,
  sampleResponses,
  sampleSettings,
  sampleSummary,
  sampleSystemItems,
  sampleTime,
} from './samples';

/** parse(JSON round trip) must reproduce the object exactly (wire / file stability). */
function expectRoundTrip(schema: z.ZodType, value: unknown): void {
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
}

describe('defaults for old files (B "fehlende Felder ergänzen")', () => {
  it('a minimal entry gets every default', () => {
    const minimal = {
      id: SAMPLE_IDS.entry,
      createdAt: sampleTime(),
      profileId: 'standard',
      cwd: 'D:\\work\\x',
      lastActivityAt: sampleTime(),
      conversations: [{ id: SAMPLE_IDS.conversation, startedAt: sampleTime() }],
    };
    const entry = entrySchema.parse(minimal);
    expect(entry).toEqual({
      ...minimal,
      title: '',
      titleSource: 'none',
      pinned: false,
      archived: false,
      conversations: [
        {
          id: SAMPLE_IDS.conversation,
          startedAt: sampleTime(),
          sessionId: null,
          endedAt: null,
          endReason: null,
          title: null,
          resetCorrelationId: null,
          costUsd: null,
          lastOrder: 0,
        },
      ],
      modelSetting: null,
      lastModel: null,
      permissionMode: null,
      effort: null,
      fastMode: null,
      cliVersion: null,
      apiKeySource: null,
      lastRunState: 'sleeping',
      contextPct: null,
      lastError: null,
      lastResultExcerpt: null,
      unread: false,
      context: null,
    } satisfies Entry);
  });

  it('a decision record without the decision snapshot loads with decision null (R0-07)', () => {
    const { decision: _decision, ...old } = sampleDecisionRecord();
    expect(decisionRecordSchema.parse(old)).toEqual({ ...old, decision: null });
    expect(decisionRecordSchema.parse(sampleDecisionRecord())).toEqual(sampleDecisionRecord());
  });

  it('a minimal profile gets every default', () => {
    const profile = profileSchema.parse({
      id: 'standard',
      name: 'Standard',
      createdAt: sampleTime(),
      updatedAt: sampleTime(),
    });
    expect(profile).toMatchObject({
      color: 'slate',
      isDefault: false,
      builtin: false,
      executable: { kind: 'auto' },
      configDir: null,
      env: {},
      contextWindow: null,
      args: [],
      passRawArgs: false,
      defaults: { model: null, permissionMode: null, effort: null },
    });
  });

  it('empty settings get defaults; the patch schema does not inject them', () => {
    expect(settingsSchema.parse({})).toEqual({ language: 'en', theme: 'dark' });
    expect(settingsPatchSchema.parse({ theme: 'light' })).toEqual({ theme: 'light' });
    expect(Object.keys(settingsPatchSchema.shape).sort()).toEqual(Object.keys(settingsSchema.shape).sort());
  });

  it('the detail patch schema does not inject defaults and covers every detail field except entryId', () => {
    expect(sessionDetailPatchSchema.parse({ queue: [] })).toEqual({ queue: [] });
    const detailKeys = Object.keys(sessionDetailSchema.shape).filter((k) => k !== 'entryId');
    expect(Object.keys(sessionDetailPatchSchema.shape).sort()).toEqual(detailKeys.sort());
  });

  it('a minimal transcript item fills its defaults', () => {
    const item = transcriptItemSchema.parse({
      id: 'u1',
      order: 1,
      at: sampleTime(),
      kind: 'user_message',
      text: { text: 'hi' },
    });
    expect(item).toEqual({
      id: 'u1',
      order: 1,
      at: sampleTime(),
      parentToolUseId: null,
      kind: 'user_message',
      text: { text: 'hi', truncated: null },
      attachments: [],
      origin: 'human',
      slashCommand: null,
      priority: null,
    });
  });
});

describe('round trips', () => {
  it('registry, profiles, settings, decisions files', () => {
    expectRoundTrip(registryFileSchema, { schemaVersion: 1, entries: [sampleEntry()] });
    expectRoundTrip(profilesFileSchema, { schemaVersion: 1, profiles: [sampleProfile()] });
    expectRoundTrip(settingsFileSchema, { schemaVersion: 1, settings: sampleSettings({ language: 'de' }) });
    expectRoundTrip(decisionRecordsFileSchema, {
      schemaVersion: 1,
      records: [
        {
          id: SAMPLE_IDS.decision,
          kind: 'plan',
          conversationId: SAMPLE_IDS.conversation,
          toolUseId: 'toolu_1',
          toolName: 'ExitPlanMode',
          requester: { kind: 'main' },
          createdAt: sampleTime(),
          resolvedAt: sampleTime(5),
          outcome: sampleOutcomes.plan_approved,
          planVersion: 1,
          planFilePath: 'C:\\plans\\a.md',
          decision: null,
        },
        sampleDecisionRecord(),
        sampleDecisionRecord({
          id: sampleDecisions.permission().id,
          kind: 'permission',
          decision: sampleDecisions.permission(),
          planVersion: null,
          planFilePath: null,
        }),
      ],
    });
  });

  it('an entry keeps unread and the context gauge (R0-17)', () => {
    expectRoundTrip(entrySchema, sampleEntry({ unread: true, context: null }));
    expectRoundTrip(entrySchema, sampleEntry());
  });

  it('init info accepts an unknown (null) permission mode of a newer CLI (R0-05)', () => {
    const base = sampleDetail().init;
    expect(base).not.toBeNull();
    if (base !== null)
      expectRoundTrip(sessionDetailSchema, sampleDetail({ init: { ...base, permissionMode: null } }));
  });

  it('host state, summary, detail', () => {
    expectRoundTrip(hostStateSchema, sampleHostState());
    expectRoundTrip(sessionSummarySchema, sampleSummary());
    expectRoundTrip(sessionDetailSchema, sampleDetail());
  });

  it('host state: nativeNotifications is additive with default false (WP22-03)', () => {
    const { nativeNotifications: _omitted, ...older } = sampleHostState();
    expect(hostStateSchema.parse(older).nativeNotifications).toBe(false);
    expectRoundTrip(hostStateSchema, sampleHostState({ nativeNotifications: true }));
    expect(hostStateSchema.safeParse({ ...older, nativeNotifications: 'yes' }).success).toBe(false);
  });

  it.each(Object.entries(sampleItems))('item %s', (_name, factory) => {
    expectRoundTrip(transcriptItemSchema, factory());
  });

  it.each(Object.entries(sampleSystemItems))('system event %s', (event, factory) => {
    const item = factory();
    expect(item.event).toBe(event);
    expectRoundTrip(transcriptItemSchema, item);
  });

  it('sampleSystemItems covers every system event of the schema', () => {
    const events = systemItemSchema.options.map((option) => option.shape.event.value);
    expect(Object.keys(sampleSystemItems).sort()).toEqual([...events].sort());
  });

  it('a tool call with subagent parent, task, decision and image result', () => {
    expectRoundTrip(
      transcriptItemSchema,
      sampleItems.toolCall({
        parentToolUseId: 'toolu_parent',
        status: 'awaiting_decision',
        inputPartial: '{"comm',
        inputTruncated: { totalChars: 100_000, blobId: SAMPLE_IDS.blob },
        result: {
          isError: true,
          content: [
            { type: 'text', text: { text: 'x', truncated: { totalChars: 60_000, blobId: SAMPLE_IDS.blob } } },
            {
              type: 'image',
              image: {
                blobId: SAMPLE_IDS.blob,
                mediaType: 'image/png',
                bytes: 1,
                width: null,
                height: null,
                name: null,
              },
            },
          ],
          structured: null,
          structuredTruncated: null,
          at: sampleTime(),
        },
        task: {
          taskId: 't1',
          taskType: 'local_agent',
          status: 'running',
          description: 'Explore',
          subagentType: 'Explore',
          isBackgrounded: true,
          summary: null,
          usage: { totalTokens: 10, toolUses: 1, durationMs: 100 },
          startedAt: sampleTime(),
          endedAt: null,
        },
        decision: {
          decisionId: SAMPLE_IDS.decision,
          kind: 'permission',
          planVersion: null,
          outcome: sampleOutcomes.allowed,
        },
      }),
    );
  });

  it.each(Object.entries(sampleDecisions))('decision %s', (_name, factory) => {
    expectRoundTrip(decisionSchema, factory());
  });

  it('a subagent requester and an expired decision', () => {
    expectRoundTrip(
      decisionSchema,
      sampleDecisions.plan({
        state: 'expired',
        requester: { kind: 'subagent', agentId: 'a1', description: 'Plan agent', parentToolUseId: 'toolu_p' },
      }),
    );
  });

  it.each(Object.entries(sampleResponses))('response %s', (_name, response) => {
    expectRoundTrip(decisionResponseSchema, response);
  });

  it.each(Object.entries(sampleOutcomes))('outcome %s', (type, outcome) => {
    expect(outcome.type).toBe(type);
    expectRoundTrip(decisionOutcomeSchema, outcome);
  });
});

describe('negative cases', () => {
  it('rejects wrong ids', () => {
    expect(entrySchema.safeParse(sampleEntry({ id: 'en_123' })).success).toBe(false);
    expect(entrySchema.safeParse(sampleEntry({ profileId: 'pf_xyz' })).success).toBe(false);
    expect(decisionSchema.safeParse(sampleDecisions.permission({ id: sampleId('cv') })).success).toBe(false);
  });

  it('rejects an entry without conversations', () => {
    expect(entrySchema.safeParse(sampleEntry({ conversations: [] })).success).toBe(false);
  });

  it('rejects a question decision without questions', () => {
    expect(decisionSchema.safeParse(sampleDecisions.question({ questions: [] })).success).toBe(false);
  });

  it('rejects a plan decision without approve modes', () => {
    expect(decisionSchema.safeParse(sampleDecisions.plan({ approveModes: [] })).success).toBe(false);
  });

  it('rejects a context window outside 100k–1M', () => {
    expect(profileSchema.safeParse(sampleProfile({ contextWindow: 99_999 })).success).toBe(false);
    expect(profileSchema.safeParse(sampleProfile({ contextWindow: 1_000_001 })).success).toBe(false);
    expect(profileSchema.safeParse(sampleProfile({ contextWindow: 200_000 })).success).toBe(true);
  });

  it('rejects unknown item kinds, system events and rule destinations', () => {
    expect(
      transcriptItemSchema.safeParse({ ...sampleItems.assistantText(), kind: 'brand_new' }).success,
    ).toBe(false);
    expect(
      transcriptItemSchema.safeParse({ ...sampleSystemItems.interrupted(), event: 'brand_new' }).success,
    ).toBe(false);
    expect(
      decisionResponseSchema.safeParse({
        kind: 'permission',
        response: { behavior: 'allow', remember: 'cliArg' },
      }).success,
    ).toBe(false);
  });

  it('rejects an empty plan revision', () => {
    expect(
      decisionResponseSchema.safeParse({ kind: 'plan', response: { behavior: 'revise', feedback: '' } })
        .success,
    ).toBe(false);
  });

  it('caps client input fields (R0-08)', () => {
    const plan = (editedPlan: string) =>
      decisionResponseSchema.safeParse({
        kind: 'plan',
        response: { behavior: 'approve', mode: 'default', editedPlan },
      }).success;
    expect(plan('x'.repeat(LIMITS.planChars))).toBe(true);
    expect(plan('x'.repeat(LIMITS.planChars + 1))).toBe(false);

    const answer = (a: Record<string, unknown>, count = 1) =>
      decisionResponseSchema.safeParse({
        kind: 'question',
        response: {
          behavior: 'answer',
          answers: Array.from({ length: count }, () => ({ question: 'Q?', selected: ['A'], ...a })),
        },
      }).success;
    expect(answer({})).toBe(true);
    expect(answer({}, LIMITS.answersMax)).toBe(true);
    expect(answer({}, LIMITS.answersMax + 1)).toBe(false);
    expect(answer({ question: 'q'.repeat(LIMITS.questionChars + 1) })).toBe(false);
    expect(answer({ selected: Array.from({ length: LIMITS.selectedMax + 1 }, () => 'A') })).toBe(false);
    expect(answer({ selected: ['a'.repeat(LIMITS.answerChars + 1)] })).toBe(false);
    expect(answer({ otherText: 'o'.repeat(LIMITS.answerChars + 1) })).toBe(false);
    expect(answer({ notes: 'n'.repeat(LIMITS.answerChars + 1) })).toBe(false);
  });

  it('rejects a host state without profiles', () => {
    expect(hostStateSchema.safeParse(sampleHostState({ profiles: [] })).success).toBe(false);
  });
});

describe('registry helpers', () => {
  const entry = sampleEntry({
    conversations: [
      sampleConversation({
        id: sampleId('cv', 1),
        sessionId: 's1',
        endedAt: sampleTime(10),
        endReason: 'clear',
      }),
      sampleConversation({
        id: sampleId('cv', 2),
        sessionId: null,
        endedAt: sampleTime(20),
        endReason: 'clear',
      }),
      sampleConversation({ id: sampleId('cv', 3), sessionId: 's3' }),
    ],
  });

  it('current conversation and session id come from the last conversation', () => {
    expect(currentConversation(entry).id).toBe(sampleId('cv', 3));
    expect(currentSessionId(entry)).toBe('s3');
    expect(
      currentSessionId(sampleEntry({ conversations: [sampleConversation({ sessionId: null })] })),
    ).toBeNull();
  });

  it('previous session ids skip conversations without a session id', () => {
    expect(previousSessionIds(entry)).toEqual(['s1']);
    expect(previousSessionIds(sampleEntry())).toEqual([]);
  });
});
