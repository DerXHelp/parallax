import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  claudeSessionIdSchema,
  clientIdSchema,
  cmdIdSchema,
  conversationIdSchema,
  decisionIdSchema,
  entryIdSchema,
  messageUuidSchema,
  profileIdSchema,
} from './common';
import {
  blobRefSchema,
  claudeInstallStatusSchema,
  contextBreakdownSchema,
  contextGaugeSchema,
  conversationSchema,
  decisionOutcomeSchema,
  decisionRecordSchema,
  decisionResponseSchema,
  decisionSchema,
  entrySchema,
  hostStateSchema,
  modelOptionSchema,
  profileSchema,
  profileSummarySchema,
  queuedPromptSchema,
  rateLimitInfoSchema,
  sessionDetailSchema,
  sessionSummarySchema,
  settingsSchema,
  transcriptItemSchema,
} from './model';
import {
  authStatusResponseSchema,
  healthResponseSchema,
  launcherCodeResponseSchema,
  serverLockFileSchema,
} from './http';
import { clientHelloSchema, helloSchema, presenceStateSchema, sessionSnapshotSchema } from './protocol';
import * as samples from './samples';
import { statusFactsSchema } from './status';

/** Strict check: the sample must parse unchanged (no stripped keys, no added defaults). */
function expectValid(schema: z.ZodType, value: unknown): void {
  const parsed = schema.safeParse(value);
  expect(parsed.error?.issues ?? []).toEqual([]);
  expect(parsed.data).toEqual(value);
}

describe('sample factories satisfy their schemas', () => {
  const cases: [string, z.ZodType, () => unknown][] = [
    ['claudeInstallStatus', claudeInstallStatusSchema, () => samples.sampleClaudeInstallStatus()],
    ['profile', profileSchema, () => samples.sampleProfile()],
    ['profileSummary', profileSummarySchema, () => samples.sampleProfileSummary()],
    ['settings', settingsSchema, () => samples.sampleSettings()],
    ['rateLimitInfo', rateLimitInfoSchema, () => samples.sampleRateLimitInfo()],
    ['hostState', hostStateSchema, () => samples.sampleHostState()],
    ['conversation', conversationSchema, () => samples.sampleConversation()],
    ['entry', entrySchema, () => samples.sampleEntry()],
    ['statusFacts', statusFactsSchema, () => samples.sampleStatusFacts()],
    ['contextGauge', contextGaugeSchema, () => samples.sampleContextGauge()],
    ['contextBreakdown', contextBreakdownSchema, () => samples.sampleContextBreakdown()],
    ['summary', sessionSummarySchema, () => samples.sampleSummary()],
    ['blobRef', blobRefSchema, () => samples.sampleBlobRef()],
    ['modelOption', modelOptionSchema, () => samples.sampleModelOption()],
    ['queuedPrompt', queuedPromptSchema, () => samples.sampleQueuedPrompt()],
    ['detail', sessionDetailSchema, () => samples.sampleDetail()],
    ['sessionSnapshot', sessionSnapshotSchema, () => samples.sampleSessionSnapshot()],
    ['presence', presenceStateSchema, () => samples.samplePresence()],
    ['hello', helloSchema, () => samples.sampleHello()],
    ['clientHello', clientHelloSchema, () => samples.sampleClientHello()],
    ['decisionRecord', decisionRecordSchema, () => samples.sampleDecisionRecord()],
    ['health', healthResponseSchema, () => samples.sampleHealthResponse()],
    ['authStatus', authStatusResponseSchema, () => samples.sampleAuthStatus()],
    ['launcherCode', launcherCodeResponseSchema, () => samples.sampleLauncherCode()],
    ['serverLockFile', serverLockFileSchema, () => samples.sampleServerLockFile()],
    ...Object.entries(samples.sampleItems).map(([name, f]): [string, z.ZodType, () => unknown] => [
      `item ${name}`,
      transcriptItemSchema,
      () => f(),
    ]),
    ...Object.entries(samples.sampleSystemItems).map(([name, f]): [string, z.ZodType, () => unknown] => [
      `system ${name}`,
      transcriptItemSchema,
      () => f(),
    ]),
    ...Object.entries(samples.sampleDecisions).map(([name, f]): [string, z.ZodType, () => unknown] => [
      `decision ${name}`,
      decisionSchema,
      () => f(),
    ]),
    ...Object.entries(samples.sampleResponses).map(([name, r]): [string, z.ZodType, () => unknown] => [
      `response ${name}`,
      decisionResponseSchema,
      () => r,
    ]),
    ...Object.entries(samples.sampleOutcomes).map(([name, o]): [string, z.ZodType, () => unknown] => [
      `outcome ${name}`,
      decisionOutcomeSchema,
      () => o,
    ]),
  ];

  it.each(cases)('%s', (_name, schema, factory) => {
    expectValid(schema, factory());
  });
});

describe('fixed ids and times', () => {
  it('ids match their schemas', () => {
    expect(entryIdSchema.parse(samples.SAMPLE_IDS.entry)).toBe('en_00000000000000000000000000000001');
    expect(conversationIdSchema.safeParse(samples.SAMPLE_IDS.conversation).success).toBe(true);
    expect(decisionIdSchema.safeParse(samples.SAMPLE_IDS.decision).success).toBe(true);
    expect(clientIdSchema.safeParse(samples.SAMPLE_IDS.client).success).toBe(true);
    expect(profileIdSchema.safeParse(samples.SAMPLE_IDS.profile).success).toBe(true);
    expect(messageUuidSchema.safeParse(samples.SAMPLE_IDS.messageUuid).success).toBe(true);
    expect(cmdIdSchema.safeParse(samples.SAMPLE_IDS.cmdId).success).toBe(true);
    expect(claudeSessionIdSchema.safeParse(samples.SAMPLE_IDS.sessionId).success).toBe(true);
    expect(entryIdSchema.safeParse(samples.sampleId('en', 255)).success).toBe(true);
    expect(cmdIdSchema.safeParse(samples.sampleUuid(4095)).success).toBe(true);
  });

  it('factories are deterministic and apply overrides', () => {
    expect(samples.sampleEntry()).toEqual(samples.sampleEntry());
    expect(samples.sampleTime(60)).toBe('2026-10-15T08:01:00.000Z');
    expect(samples.sampleEntry({ title: 'X' }).title).toBe('X');
    expect(samples.sampleItems.userMessage({ order: 7 }).order).toBe(7);
    expect(samples.sampleSystemItems.error({ order: 9 })).toMatchObject({ order: 9, event: 'error' });
  });
});
