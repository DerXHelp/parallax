/**
 * Search worker + service (WP-112, ADR-255) against real files in a temp home: transcript logs
 * written by the real TranscriptStore, plan files, entries from @shared/samples.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClientId, ConversationId, EntryId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import { searchHitSchema, type Entry, type TranscriptItem } from '@shared/model';
import { sampleConversation, sampleEntry, sampleId, sampleItems, sampleTime } from '@shared/samples';
import { planPath } from '../store/decisions';
import { createTranscriptStore } from '../store/transcripts';
import { CommandError } from '../sync/ports';
import {
  SEARCH_SNIPPET_LEAD,
  createSearchService,
  type SearchQuery,
  type SearchServiceOptions,
} from './service';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const CLIENT: ClientId = sampleId('cl', 1);

function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'parallax-search-'));
  roots.push(home);
  return home;
}

function entry(n: number, p: Partial<Entry> = {}): Entry {
  return sampleEntry({
    id: sampleId('en', n),
    title: `Session ${String(n)}`,
    conversations: [sampleConversation({ id: sampleId('cv', n) })],
    lastActivityAt: sampleTime(10_000 + n),
    ...p,
  });
}

async function writeLog(
  home: string,
  entryId: EntryId,
  conversationId: ConversationId,
  items: TranscriptItem[],
) {
  const store = createTranscriptStore({ home });
  for (const item of items) {
    store.append(entryId, conversationId, { v: 1, at: item.at, op: 'upsert', item });
  }
  await store.close();
}

const query = (text: string, includeToolOutput = false): SearchQuery => ({ text, includeToolOutput });

async function failure(promise: Promise<unknown>): Promise<ErrorPayload> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error.error;
    throw error;
  }
  throw new Error('expected a failure');
}

function service(home: string, o: Partial<SearchServiceOptions> = {}) {
  return createSearchService({ home, ...o });
}

describe('search service', () => {
  it('finds prompts and answers case-insensitively, newest first, with snippet and ranges', async () => {
    const home = tempHome();
    const a = entry(1);
    await writeLog(home, a.id, sampleId('cv', 1), [
      sampleItems.userMessage({
        id: 'u1',
        at: sampleTime(1),
        text: { text: 'Fix the LOGIN form', truncated: null },
      }),
      sampleItems.assistantText({
        id: 'a1',
        at: sampleTime(2),
        text: 'The login form is fixed. Login works.',
      }),
      sampleItems.thinking({
        id: 't1',
        at: sampleTime(3),
        text: { text: 'login thoughts', truncated: null },
      }),
    ]);
    const r = await service(home).query(CLIENT, query('login'), [a]);
    expect(r.truncated).toBe(false);
    expect(r.hits).toEqual([
      {
        entryId: a.id,
        conversationId: sampleId('cv', 1),
        itemId: 'a1',
        kind: 'answer',
        snippet: 'The login form is fixed. Login works.',
        ranges: [
          [4, 9],
          [25, 30],
        ],
        at: sampleTime(2),
      },
      {
        entryId: a.id,
        conversationId: sampleId('cv', 1),
        itemId: 'u1',
        kind: 'prompt',
        snippet: 'Fix the LOGIN form',
        ranges: [[8, 13]],
        at: sampleTime(1),
      },
    ]);
    for (const hit of r.hits) expect(searchHitSchema.parse(hit)).toEqual(hit);
  });

  it('tool calls only with includeToolOutput (input strings and result text)', async () => {
    const home = tempHome();
    const a = entry(1);
    await writeLog(home, a.id, sampleId('cv', 1), [
      sampleItems.toolCall({ id: 'tc1', at: sampleTime(1), input: { command: 'npm run deploy' } }),
      sampleItems.toolCall({
        id: 'tc2',
        at: sampleTime(2),
        input: { command: 'ls' },
        result: {
          isError: false,
          content: [{ type: 'text', text: { text: 'deploy.sh\nREADME.md', truncated: null } }],
          structured: null,
          structuredTruncated: null,
          at: sampleTime(2),
        },
      }),
    ]);
    const s = service(home);
    expect((await s.query(CLIENT, query('deploy'), [a])).hits).toEqual([]);
    const r = await s.query(CLIENT, query('deploy', true), [a]);
    expect(r.hits.map((h) => [h.itemId, h.kind, h.snippet])).toEqual([
      ['tc2', 'tool', 'deploy.sh README.md'],
      ['tc1', 'tool', 'npm run deploy'],
    ]);
  });

  it('titles, turn summaries and plans are searched as well', async () => {
    const home = tempHome();
    const a = entry(1, {
      title: 'Refactor billing',
      turnSummary: {
        source: 'claude',
        text: 'Billing module split',
        category: null,
        needsAction: false,
        at: sampleTime(500),
      },
    });
    await mkdir(path.dirname(planPath(home, a.id, 1)), { recursive: true });
    await writeFile(planPath(home, a.id, 1), '# Plan\n\n1. Move the billing code\n2. Tests\n', 'utf8');
    await writeFile(path.join(path.dirname(planPath(home, a.id, 1)), 'notes.txt'), 'billing', 'utf8');
    const r = await service(home).query(CLIENT, query('billing'), [a]);
    const byKind = Object.fromEntries(r.hits.map((h) => [h.kind, h]));
    expect(Object.keys(byKind).sort()).toEqual(['plan', 'summary', 'title']);
    expect(byKind.title).toMatchObject({ snippet: 'Refactor billing', at: a.lastActivityAt, itemId: null });
    expect(byKind.summary).toMatchObject({ snippet: 'Billing module split', at: sampleTime(500) });
    expect(byKind.plan).toMatchObject({
      snippet: '1. Move the billing code',
      conversationId: null,
      itemId: null,
    });
  });

  it('the last line of an item wins; removed items are not found', async () => {
    const home = tempHome();
    const a = entry(1);
    const store = createTranscriptStore({ home });
    const cv = sampleId('cv', 1);
    const u1 = sampleItems.userMessage({ id: 'u1', text: { text: 'alpha beta', truncated: null } });
    const u2 = sampleItems.userMessage({ id: 'u2', text: { text: 'beta gamma', truncated: null } });
    store.append(a.id, cv, { v: 1, at: u1.at, op: 'upsert', item: u1 });
    store.append(a.id, cv, { v: 1, at: u2.at, op: 'upsert', item: u2 });
    store.append(a.id, cv, { v: 1, at: u2.at, op: 'remove', itemId: 'u2' });
    await store.close();
    const r = await service(home).query(CLIENT, query('beta'), [a]);
    expect(r.hits.map((h) => h.itemId)).toEqual(['u1']);
  });

  it('a later version of an item that no longer matches drops its earlier hit', async () => {
    const home = tempHome();
    const a = entry(1);
    await writeLog(home, a.id, sampleId('cv', 1), [
      sampleItems.assistantText({ id: 'a1', text: 'draft with needle' }),
      sampleItems.assistantText({ id: 'a2', text: 'needle stays' }),
      sampleItems.assistantText({ id: 'a1', text: 'final text' }),
    ]);
    const r = await service(home).query(CLIENT, query('needle'), [a]);
    expect(r.hits.map((h) => h.itemId)).toEqual(['a2']);
  });

  it('a long text: at most searchSnippetChars around the first match, line breaks as spaces', async () => {
    const home = tempHome();
    const a = entry(1);
    const text = `${'x'.repeat(1000)}\nneedle here\n${'y'.repeat(1000)} needle`;
    await writeLog(home, a.id, sampleId('cv', 1), [sampleItems.assistantText({ id: 'a1', text })]);
    const [hit] = (await service(home).query(CLIENT, query('NEEDLE'), [a])).hits;
    expect(hit?.snippet.length).toBe(400);
    expect(hit?.snippet).not.toMatch(/\n/);
    const [start, end] = hit?.ranges[0] ?? [0, 0];
    expect(hit?.snippet.slice(start, end)).toBe('needle');
    expect(start).toBe(SEARCH_SNIPPET_LEAD);
  });

  it('search text with JSON-escaped and regex characters matches literally', async () => {
    const home = tempHome();
    const a = entry(1);
    await writeLog(home, a.id, sampleId('cv', 1), [
      sampleItems.userMessage({ id: 'u1', text: { text: 'run "a.b(c)" now', truncated: null } }),
      sampleItems.userMessage({ id: 'u2', text: { text: 'run aXb(c) now', truncated: null } }),
    ]);
    const r = await service(home).query(CLIENT, query('"a.b(c)"'), [a]);
    expect(r.hits.map((h) => h.itemId)).toEqual(['u1']);
  });

  it('at most `limit` hits, newest first, truncated; older entries are not scanned once full', async () => {
    const home = tempHome();
    const a = entry(1, { lastActivityAt: sampleTime(100) });
    const b = entry(2, { lastActivityAt: sampleTime(50) });
    await writeLog(
      home,
      a.id,
      sampleId('cv', 1),
      [1, 2, 3, 4, 5].map((n) =>
        sampleItems.userMessage({
          id: `u${String(n)}`,
          order: n,
          at: sampleTime(n + 60),
          text: { text: 'match', truncated: null },
        }),
      ),
    );
    await writeLog(home, b.id, sampleId('cv', 2), [
      sampleItems.userMessage({ id: 'old', at: sampleTime(10), text: { text: 'match', truncated: null } }),
    ]);
    const r = await service(home, { limit: 3 }).query(CLIENT, query('match'), [b, a]);
    expect(r.hits.map((h) => h.itemId)).toEqual(['u5', 'u4', 'u3']);
    expect(r.truncated).toBe(true);
  });

  it('over-long lines are skipped, the rest is still searched', async () => {
    const home = tempHome();
    const a = entry(1);
    await writeLog(home, a.id, sampleId('cv', 1), [
      sampleItems.assistantText({ id: 'big', at: sampleTime(2), text: `match ${'z'.repeat(5000)}` }),
      sampleItems.assistantText({ id: 'small', at: sampleTime(1), text: 'match' }),
    ]);
    const r = await service(home, { maxLineBytes: 2000 }).query(CLIENT, query('match'), [a]);
    expect(r.hits.map((h) => h.itemId)).toEqual(['small']);
  });

  it('missing files and folders are no error', async () => {
    const r = await service(tempHome()).query(CLIENT, query('anything'), [entry(1)]);
    expect(r).toEqual({ hits: [], truncated: false });
  });

  it('a newer query of the same window supersedes the older one; other windows are independent', async () => {
    const home = tempHome();
    const a = entry(1, { title: 'Alpha' });
    const s = service(home);
    const first = s.query(CLIENT, query('alpha'), [a]);
    const other = s.query(sampleId('cl', 2), query('alpha'), [a]);
    const second = s.query(CLIENT, query('alpha'), [a]);
    expect(await failure(first)).toMatchObject({ code: 'SEARCH_FAILED', params: { reason: 'superseded' } });
    expect((await second).hits).toHaveLength(1);
    expect((await other).hits).toHaveLength(1);
  });

  it('a search that takes too long ends with timeout', async () => {
    const s = service(tempHome(), { timeoutMs: 1 });
    expect(await failure(s.query(CLIENT, query('alpha'), [entry(1)]))).toMatchObject({
      code: 'SEARCH_FAILED',
      params: { reason: 'timeout' },
    });
  });

  it('more queries than maxConcurrent wait and still finish; close() fails the rest', async () => {
    const home = tempHome();
    const s = service(home, { maxConcurrent: 1 });
    const results = await Promise.all(
      [1, 2, 3].map((n) => s.query(sampleId('cl', n), query('session'), [entry(1)])),
    );
    expect(results.map((r) => r.hits.length)).toEqual([1, 1, 1]);
    const pending = s.query(CLIENT, query('session'), [entry(1)]);
    s.close();
    expect(await failure(pending)).toMatchObject({ code: 'SEARCH_FAILED', params: { reason: 'failed' } });
  });
});
