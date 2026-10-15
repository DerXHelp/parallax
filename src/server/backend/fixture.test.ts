/**
 * The fixture reader loads every SDK fixture, the typed payload views accept every event of their
 * kind, and the item-id assumptions of WP-02 §5.6 hold for every recorded stream.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  fixtureCallPayloadSchema,
  fixtureCanUseToolPayloadSchema,
  fixtureControlPayloadSchema,
  fixtureDecisionPayloadSchema,
  fixtureInputPayloadSchema,
  fixtureMessagePayloadSchema,
  fixturesDir,
  listFixtureScenarios,
  loadFixture,
  parseFixture,
  type EventKind,
  type ParsedFixture,
} from './fixture';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = fixturesDir(repoRoot);
const scenarios = await listFixtureScenarios(dir);
const fixtures = new Map<string, ParsedFixture>();
for (const scenario of scenarios)
  fixtures.set(scenario, await loadFixture(path.join(dir, `${scenario}.jsonl`)));

function fixture(scenario: string): ParsedFixture {
  const parsed = fixtures.get(scenario);
  if (parsed === undefined) throw new Error(`fixture ${scenario} not loaded`);
  return parsed;
}

const views: Partial<Record<EventKind, z.ZodType>> = {
  message: fixtureMessagePayloadSchema,
  canUseTool: fixtureCanUseToolPayloadSchema,
  decision: fixtureDecisionPayloadSchema,
  input: fixtureInputPayloadSchema,
  control: fixtureControlPayloadSchema,
  call: fixtureCallPayloadSchema,
};

// Minimal tolerant views of the SDK messages needed for the item-id checks.
const streamEventSchema = z.looseObject({
  type: z.literal('stream_event'),
  api_message_id: z.string().optional(),
  event: z.looseObject({
    type: z.string(),
    index: z.number().optional(),
    message: z.looseObject({ id: z.string() }).optional(),
  }),
});
const assistantSchema = z.looseObject({
  type: z.literal('assistant'),
  uuid: z.string(),
  message: z.looseObject({ id: z.string(), content: z.array(z.unknown()) }),
});
const withUuidSchema = z.looseObject({
  type: z.string(),
  uuid: z.string(),
  isReplay: z.boolean().optional(),
});

describe('fixture reader', () => {
  it('finds all recorded scenarios', () => {
    expect(dir).toBe(path.join(repoRoot, 'test', 'fixtures', 'sdk'));
    expect(scenarios.length).toBeGreaterThanOrEqual(12);
    expect(scenarios).toContain('permissions');
    expect(scenarios).toContain('history');
  });

  it('rejects broken files with line numbers', () => {
    expect(() => parseFixture('', 'x')).toThrow('x: empty file');
    const header = JSON.stringify({
      fixtureVersion: 1,
      scenario: 'x',
      sdkVersion: '1',
      cliVersion: '1',
      recordedAt: 'now',
      options: {},
    });
    expect(() => parseFixture(`${header}\n{"seq":2,"tMs":0,"kind":"mark","payload":{}}`, 'x')).toThrow(
      'x:2: seq 2, expected 1',
    );
    expect(() => parseFixture(`${header}\n{"seq":1,"tMs":0,"kind":"message","payload":{}}`, 'x')).toThrow(
      'message payload without type',
    );
    expect(() => parseFixture('{"fixtureVersion":2}', 'x')).toThrow('x:1: invalid header');
  });

  describe.each(scenarios)('%s', (scenario) => {
    const { header, events } = fixture(scenario);

    it('header scenario equals the file name', () => {
      expect(header.scenario).toBe(scenario);
      expect(events.at(-1)?.seq).toBe(events.length);
    });

    it('typed payload views parse every event of their kind', () => {
      for (const event of events) {
        const view = views[event.kind];
        if (view === undefined) continue;
        const parsed = view.safeParse(event.payload);
        expect(
          parsed.success,
          `${scenario}#${String(event.seq)} ${event.kind}: ${parsed.error?.message ?? ''}`,
        ).toBe(true);
      }
    });

    it('item-id assumptions hold (WP-02 §5.6)', () => {
      const blockStarts = new Map<string, number[]>();
      const ordinals = new Map<string, number>();
      const itemUuids = new Set<string>();
      let currentMessageId: string | null = null;

      for (const event of events) {
        if (event.kind !== 'message') continue;
        const stream = streamEventSchema.safeParse(event.payload);
        if (stream.success) {
          const ev = stream.data.event;
          if (ev.type === 'message_start' && ev.message !== undefined) currentMessageId = ev.message.id;
          if (ev.type === 'content_block_start' && ev.index !== undefined) {
            const id = stream.data.api_message_id ?? currentMessageId ?? '?';
            blockStarts.set(id, [...(blockStarts.get(id) ?? []), ev.index]);
          }
          continue;
        }
        const assistant = assistantSchema.safeParse(event.payload);
        if (assistant.success) {
          const { id, content } = assistant.data.message;
          // Every assistant message carries exactly one content block …
          expect(content.length, `${scenario}#${String(event.seq)}`).toBe(1);
          // … and its ordinal per message.id equals content_block_start.index (id = messageId:blockIndex).
          const ordinal = ordinals.get(id) ?? 0;
          ordinals.set(id, ordinal + 1);
          const starts = blockStarts.get(id);
          if (starts !== undefined) expect(starts[ordinal], `${scenario}#${String(event.seq)}`).toBe(ordinal);
          continue;
        }
        // Items keyed by uuid (system events, results, prompts) must have unique ids.
        const withUuid = withUuidSchema.safeParse(event.payload);
        if (withUuid.success && withUuid.data.isReplay !== true) {
          expect(itemUuids.has(withUuid.data.uuid), `${scenario}#${String(event.seq)} duplicate uuid`).toBe(
            false,
          );
          itemUuids.add(withUuid.data.uuid);
        }
      }

      for (const [id, starts] of blockStarts) {
        expect(starts, `${scenario} ${id}`).toEqual(starts.map((_, i) => i));
      }
    });
  });
});
