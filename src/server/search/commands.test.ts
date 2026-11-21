/**
 * search.query / transcript.loadAround (WP-112): which entries reach the search service, and the
 * error codes of the jump to a hit. The worker itself is covered by service.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { ClientId, EntryId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { Entry } from '@shared/model';
import { commandResultSchemas, type HostCommand } from '@shared/protocol';
import { sampleConversation, sampleEntry, sampleId, sampleItems, sampleTime } from '@shared/samples';
import { createMemoryStores } from '../sessions/testing/memoryStores';
import { CommandError, type CommandContext } from '../sync/ports';
import { createSearchCommands } from './commands';
import type { SearchQuery, SearchService } from './service';

const CTX: CommandContext = { clientId: sampleId('cl', 1), cmdId: 'cmd-1' };

function entry(n: number, p: Partial<Entry> = {}): Entry {
  return sampleEntry({
    id: sampleId('en', n),
    conversations: [sampleConversation({ id: sampleId('cv', n) })],
    ...p,
  });
}

interface Call {
  clientId: ClientId;
  query: SearchQuery;
  entryIds: EntryId[];
}

function stubService(): SearchService & { calls: Call[]; closed: number } {
  const calls: Call[] = [];
  const stub = {
    calls,
    closed: 0,
    query: (clientId: ClientId, query: SearchQuery, entries: readonly Entry[]) => {
      calls.push({ clientId, query, entryIds: entries.map((e) => e.id) });
      return Promise.resolve({ hits: [], truncated: false });
    },
    close: () => {
      stub.closed += 1;
    },
  };
  return stub;
}

async function failure(promise: Promise<unknown>): Promise<ErrorPayload> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error.error;
    throw error;
  }
  throw new Error('expected a failure');
}

function setup(entries: Entry[] = [entry(1), entry(2, { archived: true })]) {
  const items = [1, 2, 3, 4, 5].map((n) =>
    sampleItems.userMessage({ id: `u${String(n)}`, order: n, at: sampleTime(n) }),
  );
  const stores = createMemoryStores({
    entries,
    transcripts: [{ entryId: sampleId('en', 1), conversationId: sampleId('cv', 1), items }],
  });
  const service = stubService();
  const handler = createSearchCommands({
    home: 'unused',
    registry: stores.registry,
    transcripts: stores.transcripts,
    service,
  });
  return { handler, service };
}

const search = (p: Partial<Extract<HostCommand, { name: 'search.query' }>> = {}): HostCommand => ({
  name: 'search.query',
  text: 'needle',
  includeArchived: true,
  includeToolOutput: false,
  ...p,
});

const around = (p: Partial<Extract<HostCommand, { name: 'transcript.loadAround' }>> = {}): HostCommand => ({
  name: 'transcript.loadAround',
  entryId: sampleId('en', 1),
  conversationId: sampleId('cv', 1),
  itemId: 'u3',
  around: 1,
  ...p,
});

describe('search.query', () => {
  it('passes the window, the text and the tool flag on; archived sessions only with includeArchived', async () => {
    const { handler, service } = setup();
    await expect(handler.handle(search(), CTX)).resolves.toEqual({ hits: [], truncated: false });
    await handler.handle(search({ includeArchived: false, includeToolOutput: true }), CTX);
    expect(service.calls).toEqual([
      {
        clientId: CTX.clientId,
        query: { text: 'needle', includeToolOutput: false },
        entryIds: [sampleId('en', 1), sampleId('en', 2)],
      },
      {
        clientId: CTX.clientId,
        query: { text: 'needle', includeToolOutput: true },
        entryIds: [sampleId('en', 1)],
      },
    ]);
  });

  it('close() ends the service', () => {
    const { handler, service } = setup();
    handler.close();
    expect(service.closed).toBe(1);
  });
});

describe('transcript.loadAround', () => {
  it('returns the item and its neighbours by order', async () => {
    const { handler } = setup();
    const window = commandResultSchemas['transcript.loadAround'].parse(await handler.handle(around(), CTX));
    expect(window).toMatchObject({ hasEarlier: true, hasLater: true });
    expect(window.items.map((i) => i.id)).toEqual(['u2', 'u3', 'u4']);
  });

  it('unknown entry, conversation or item → ENTRY_NOT_FOUND, CONVERSATION_NOT_FOUND, VALIDATION_FAILED', async () => {
    const { handler } = setup();
    expect(await failure(handler.handle(around({ entryId: sampleId('en', 9) }), CTX))).toMatchObject({
      code: 'ENTRY_NOT_FOUND',
      params: { entryId: sampleId('en', 9) },
    });
    expect(await failure(handler.handle(around({ conversationId: sampleId('cv', 9) }), CTX))).toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
      params: { conversationId: sampleId('cv', 9) },
    });
    expect(await failure(handler.handle(around({ itemId: 'nope' }), CTX))).toMatchObject({
      code: 'VALIDATION_FAILED',
      params: { reason: 'item_not_found' },
    });
  });
});

describe('without deps (until the composition wires them)', () => {
  it('both commands answer NOT_IMPLEMENTED', async () => {
    const handler = createSearchCommands();
    expect(await failure(handler.handle(search(), CTX))).toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(await failure(handler.handle(around(), CTX))).toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(() => {
      handler.close();
    }).not.toThrow();
  });
});
