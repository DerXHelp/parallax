import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@shared/common';
import { sessionDetailSchema, type TranscriptItem } from '@shared/model';
import {
  sampleConversation,
  sampleDecisions,
  sampleEntry,
  sampleId,
  sampleItems,
  sampleQueuedPrompt,
} from '@shared/samples';
import { createFakeBackend, createFakeHistoryStore } from '../backend/fakeBackend';
import { createFakeClaudeIntegration } from '../backend/fake/integration';
import { loadFixtureScenario } from '../backend/fake/testing';
import {
  applyToMirror,
  baseView,
  emptyDetail,
  findToolCallIn,
  readMirrorItems,
  sortDecisions,
} from './mirror';
import { normalizeHistory } from './normalizer';
import { createMemoryStores } from './testing/memoryStores';

function many(n: number): TranscriptItem[] {
  return Array.from({ length: n }, (_, i) => sampleItems.userMessage({ id: `u${String(i)}`, order: i + 1 }));
}

describe('mirror view', () => {
  it('emptyDetail is schema-true; baseView sorts items and decisions', () => {
    const entry = sampleEntry();
    const detail = emptyDetail({
      entryId: entry.id,
      conversationId: entry.conversations[0]?.id ?? sampleId('cv'),
      conversations: entry.conversations,
      models: null,
      queue: [sampleQueuedPrompt()],
    });
    expect(sessionDetailSchema.parse(detail)).toEqual(detail);
    const late = sampleDecisions.permission({ id: sampleId('dc', 2), createdAt: '2026-10-15T09:00:00.000Z' });
    const early = sampleDecisions.question({ id: sampleId('dc', 3), createdAt: '2026-10-15T08:00:00.000Z' });
    const view = baseView({
      entry,
      items: [sampleItems.assistantText(), sampleItems.userMessage()],
      hasEarlier: false,
      decisions: [late, early],
      models: null,
      queue: [],
    });
    expect(view.items.map((i) => i.order)).toEqual([1, 3]);
    expect(view.decisions.map((d) => d.id)).toEqual([early.id, late.id]);
    expect(sortDecisions([late, early])[0]).toBe(early);
  });

  it('applyToMirror trims like the hub (LIMITS.snapshotItems) and finds tool calls', () => {
    const view = baseView({
      entry: sampleEntry(),
      items: [],
      hasEarlier: false,
      decisions: [],
      models: null,
      queue: [],
    });
    const ops = many(LIMITS.snapshotItems + 5).map((item) => ({ op: 'item.upsert' as const, item }));
    const next = applyToMirror(view, [
      ...ops,
      { op: 'item.upsert', item: sampleItems.toolCall({ order: 999 }) },
    ]);
    expect(next.items).toHaveLength(LIMITS.snapshotItems);
    expect(next.hasEarlier).toBe(true);
    expect(findToolCallIn(next, sampleItems.toolCall().toolUseId)?.order).toBe(999);
    expect(findToolCallIn(next, 'nope')).toBeNull();
    expect(findToolCallIn(null, 'nope')).toBeNull();
  });
});

describe('readMirrorItems (A.3 fallback)', () => {
  it('the log tail wins; without log and session id nothing is imported', async () => {
    const stores = createMemoryStores({
      transcripts: [{ entryId: sampleId('en', 1), conversationId: sampleId('cv', 1), items: many(3) }],
    });
    const backend = createFakeBackend();
    const deps = {
      transcripts: stores.transcripts,
      backend,
      claude: createFakeClaudeIntegration(),
      normalizeHistory,
      storeBlob: (data: Uint8Array | string, mediaType: string, name?: string | null) =>
        stores.blobs.put(data, mediaType, name),
      now: () => new Date(),
      onHistoryError: vi.fn(),
    };
    const logged = sampleEntry({
      id: sampleId('en', 1),
      conversations: [sampleConversation({ id: sampleId('cv', 1) })],
    });
    expect(await readMirrorItems(logged, deps)).toMatchObject({ hasEarlier: false, imported: [] });
    const fresh = sampleEntry({
      id: sampleId('en', 2),
      conversations: [sampleConversation({ id: sampleId('cv', 2), sessionId: null, lastOrder: 4 })],
    });
    expect(await readMirrorItems(fresh, deps)).toEqual({ items: [], hasEarlier: false, imported: [] });
  });

  it('empty log + Claude session â†’ readHistory â†’ normalizeHistory (orders from 1); failures are reported', async () => {
    const parsed = await loadFixtureScenario('history');
    const history = createFakeHistoryStore();
    history.seedFromHistoryFixture(parsed);
    const stores = createMemoryStores();
    const onHistoryError = vi.fn();
    const claude = createFakeClaudeIntegration();
    const deps = {
      transcripts: stores.transcripts,
      backend: createFakeBackend({ history }),
      claude,
      normalizeHistory,
      storeBlob: (data: Uint8Array | string, mediaType: string, name?: string | null) =>
        stores.blobs.put(data, mediaType, name),
      now: () => new Date(),
      onHistoryError,
    };
    const entry = sampleEntry({
      id: sampleId('en', 3),
      conversations: [
        sampleConversation({ id: sampleId('cv', 3), sessionId: '8bd89597-a855-4639-b491-86fb5b099719' }),
      ],
    });
    const read = await readMirrorItems(entry, deps);
    expect(read.imported.map((i) => i.order)).toEqual(read.imported.map((_, i) => i + 1));
    expect(read.items.some((i) => i.kind === 'tool_call' && i.toolName === 'AskUserQuestion')).toBe(true);
    claude.setLaunchError({ code: 'CLAUDE_NOT_FOUND', params: {} });
    expect(await readMirrorItems(entry, deps)).toEqual({ items: [], hasEarlier: false, imported: [] });
    expect(onHistoryError).toHaveBeenCalledTimes(1);
  });
});
